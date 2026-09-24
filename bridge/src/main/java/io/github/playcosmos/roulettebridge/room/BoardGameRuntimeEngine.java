package io.github.playcosmos.roulettebridge.room;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.github.playcosmos.roulettebridge.db.BridgeDatabase;
import io.github.playcosmos.roulettebridge.soop.SoopDonation;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.function.IntUnaryOperator;

import static io.github.playcosmos.roulettebridge.room.RoomModels.*;

public final class BoardGameRuntimeEngine {
    private static final Gson GSON = new Gson();
    private static final int MAX_BONUS_CHAIN = 32;
    private static final int MAX_LANDING_CHAIN = 64;

    private final BridgeDatabase database;
    private final Consumer<BoardTurnEvent> eventSink;
    private final IntUnaryOperator randomInt;

    public BoardGameRuntimeEngine(
        BridgeDatabase database,
        Consumer<BoardTurnEvent> eventSink
    ) {
        this(database, eventSink, new SecureRandom()::nextInt);
    }

    BoardGameRuntimeEngine(
        BridgeDatabase database,
        Consumer<BoardTurnEvent> eventSink,
        IntUnaryOperator randomInt
    ) {
        this.database = Objects.requireNonNull(database, "database");
        this.eventSink = eventSink == null ? event -> {} : eventSink;
        this.randomInt = Objects.requireNonNull(randomInt, "randomInt");
    }

    public synchronized ProcessResult process(SoopDonation donation) throws SQLException {
        validateDonation(donation);
        String fingerprint = fingerprint(donation);
        var roomIds = findMatchingRooms(donation.donorId(), donation.balloonCount());

        var events = new ArrayList<BoardTurnEvent>();
        int duplicateRooms = 0;

        for (String roomId : roomIds) {
            var result = processRoom(roomId, donation, fingerprint);
            if (result.duplicate()) {
                duplicateRooms += 1;
            } else if (result.event() != null) {
                events.add(result.event());
            }
        }

        for (var event : events) {
            try {
                eventSink.accept(event);
            } catch (RuntimeException error) {
                System.err.println(
                    "[board-game] websocket dispatch failed room="
                        + event.roomId() + " event=" + event.eventId()
                        + ": " + error.getMessage()
                );
            }
        }

        return new ProcessResult(
            roomIds.size(),
            events.size(),
            duplicateRooms,
            List.copyOf(events)
        );
    }

    public synchronized RuntimeSnapshot snapshot(String roomId) throws SQLException {
        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                var room = loadRoom(connection, roomId);
                ensureRuntimeState(connection, room);
                var board = loadRuntimeBoard(connection, roomId);
                var players = loadPlayerStates(connection, roomId);
                long sequence = readRuntimeSequence(connection, roomId);
                connection.commit();
                return new RuntimeSnapshot(
                    roomId,
                    sequence,
                    board,
                    players.stream().map(MutablePlayer::snapshot).toList()
                );
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sqlError) throw sqlError;
                throw new SQLException("failed to load board runtime snapshot", error);
            } finally {
                connection.setAutoCommit(true);
            }
        }
    }

    private RoomProcessResult processRoom(
        String roomId,
        SoopDonation donation,
        String fingerprint
    ) throws SQLException {
        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                var duplicate = findDuplicate(connection, roomId, fingerprint);
                if (duplicate != null) {
                    connection.rollback();
                    return new RoomProcessResult(true, duplicate);
                }

                var room = loadRoom(connection, roomId);
                ensureRuntimeState(connection, room);

                var board = mutableBoard(loadRuntimeBoard(connection, roomId));
                var players = loadPlayerStates(connection, roomId);
                var player = players.stream()
                    .filter(value -> value.soopId.equals(donation.donorId()))
                    .findFirst()
                    .orElseThrow(() -> new SQLException("matched room player state is missing"));

                long sequence = readRuntimeSequence(connection, roomId) + 1;
                String eventId = "BG" + Instant.now().toEpochMilli() + "-" + shortUuid();
                String createdAt = Instant.now().toString();

                int initialPosition = player.position;
                boolean openingThrowSkipped = false;
                boolean safetyStopped = false;
                var throwResolutions = new ArrayList<ResolvedThrow>();
                var allCellUpdates = new ArrayList<CellUpdate>();

                if (player.skipNextThrows > 0) {
                    player.skipNextThrows -= 1;
                    openingThrowSkipped = true;
                } else {
                    int pendingBonusThrows = 0;
                    int throwIndex = 0;
                    boolean shouldThrow = true;

                    while (shouldThrow && throwIndex < MAX_BONUS_CHAIN) {
                        throwIndex += 1;
                        int throwStart = player.position;
                        var outcome = roll(room.config().movement());

                        int throwLanding = advancePlayer(
                            player,
                            outcome.steps(),
                            room.config().board().cellCount()
                        );

                        var updates = new ArrayList<CellUpdate>();
                        if (throwStart != throwLanding) {
                            rerollIfVacated(
                                room,
                                board,
                                players,
                                throwStart,
                                updates
                            );
                        }

                        boolean naturalBonus = outcome.bonusThrow();
                        if (naturalBonus) pendingBonusThrows += 1;

                        var landingChain = resolveLandingChain(
                            room,
                            board,
                            players,
                            player,
                            pendingBonusThrows,
                            updates
                        );
                        pendingBonusThrows = landingChain.pendingBonusThrows();
                        safetyStopped = safetyStopped || landingChain.safetyStopped();

                        boolean bonusConsumedBySkip = false;
                        boolean nextThrowScheduled = false;

                        while (pendingBonusThrows > 0 && !nextThrowScheduled) {
                            if (
                                player.skipNextThrows > 0
                                && room.config().rules().skipNextThrowConsumesBonus()
                            ) {
                                pendingBonusThrows -= 1;
                                player.skipNextThrows -= 1;
                                bonusConsumedBySkip = true;
                            } else {
                                pendingBonusThrows -= 1;
                                nextThrowScheduled = true;
                            }
                        }

                        allCellUpdates.addAll(updates);
                        throwResolutions.add(new ResolvedThrow(
                            throwIndex,
                            room.config().movement().generator(),
                            outcome.dice(),
                            outcome.yut(),
                            outcome.steps(),
                            throwStart,
                            throwLanding,
                            player.position,
                            naturalBonus,
                            nextThrowScheduled,
                            bonusConsumedBySkip,
                            landingChain.landings().isEmpty()
                                ? null
                                : landingChain.landings().get(0),
                            landingChain.landings(),
                            List.copyOf(updates),
                            player.skipNextThrows
                        ));

                        shouldThrow = nextThrowScheduled;
                    }

                    if (shouldThrow) {
                        safetyStopped = true;
                    }
                }

                persistPlayerState(connection, player, createdAt);
                persistRuntimeBoard(
                    connection,
                    roomId,
                    new BoardPreview(
                        board.seed(),
                        board.cellCount(),
                        board.layoutStyle(),
                        List.copyOf(board.cells()),
                        board.rerollPool()
                    ),
                    sequence,
                    createdAt
                );

                var event = new BoardTurnEvent(
                    "board.turn",
                    eventId,
                    roomId,
                    sequence,
                    donation.donorId(),
                    donation.nickname(),
                    donation.balloonCount(),
                    player.soopId,
                    player.displayName,
                    room.config().movement().generator(),
                    initialPosition,
                    player.position,
                    player.laps,
                    openingThrowSkipped,
                    player.skipNextThrows,
                    safetyStopped,
                    List.copyOf(throwResolutions),
                    List.copyOf(allCellUpdates),
                    createdAt
                );

                insertEvent(
                    connection,
                    event,
                    fingerprint,
                    donation.donorId(),
                    donation.balloonCount()
                );

                connection.commit();
                return new RoomProcessResult(false, event);
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sqlError) throw sqlError;
                throw new SQLException("failed to process board game donation for room " + roomId, error);
            } finally {
                connection.setAutoCommit(true);
            }
        }
    }

    private List<String> findMatchingRooms(String soopId, int balloonCount) throws SQLException {
        var roomIds = new ArrayList<String>();
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT br.room_id
                 FROM board_room br
                 JOIN board_room_player p ON p.room_id = br.room_id
                 WHERE br.status = 'READY'
                   AND p.soop_id = ?
                   AND p.balloon_trigger = ?
                 ORDER BY br.created_at ASC
                 """)) {
            statement.setString(1, soopId);
            statement.setInt(2, balloonCount);
            try (var rows = statement.executeQuery()) {
                while (rows.next()) roomIds.add(rows.getString(1));
            }
        }
        return roomIds;
    }

    private static RoomContext loadRoom(Connection connection, String roomId) throws SQLException {
        try (var statement = connection.prepareStatement("""
            SELECT status, config_json, committed_board_json
            FROM board_room
            WHERE room_id = ?
            """)) {
            statement.setString(1, roomId);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) throw new SQLException("room not found: " + roomId);
                if (!"READY".equals(rows.getString("status"))) {
                    throw new SQLException("room is not READY: " + roomId);
                }
                String committed = rows.getString("committed_board_json");
                if (committed == null || committed.isBlank()) {
                    throw new SQLException("room committed board is missing: " + roomId);
                }
                return new RoomContext(
                    roomId,
                    GSON.fromJson(rows.getString("config_json"), NormalizedRoomConfig.class),
                    GSON.fromJson(committed, BoardPreview.class)
                );
            }
        }
    }

    private static void ensureRuntimeState(Connection connection, RoomContext room) throws SQLException {
        String now = Instant.now().toString();

        try (var statement = connection.prepareStatement("""
            INSERT OR IGNORE INTO board_game_state(
                room_id, board_json, event_sequence, updated_at
            ) VALUES (?, ?, 0, ?)
            """)) {
            statement.setString(1, room.roomId());
            statement.setString(2, GSON.toJson(room.committedBoard()));
            statement.setString(3, now);
            statement.executeUpdate();
        }

        try (var statement = connection.prepareStatement("""
            INSERT OR IGNORE INTO board_game_player_state(
                room_id, player_index, soop_id, position, laps,
                skip_next_throws, updated_at
            ) VALUES (?, ?, ?, 0, 0, 0, ?)
            """)) {
            for (int i = 0; i < room.config().players().size(); i++) {
                var player = room.config().players().get(i);
                statement.setString(1, room.roomId());
                statement.setInt(2, i);
                statement.setString(3, player.soopId());
                statement.setString(4, now);
                statement.addBatch();
            }
            statement.executeBatch();
        }
    }

    private static BoardPreview loadRuntimeBoard(Connection connection, String roomId) throws SQLException {
        try (var statement = connection.prepareStatement(
            "SELECT board_json FROM board_game_state WHERE room_id = ?"
        )) {
            statement.setString(1, roomId);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) throw new SQLException("runtime board is missing: " + roomId);
                return GSON.fromJson(rows.getString(1), BoardPreview.class);
            }
        }
    }

    private static long readRuntimeSequence(Connection connection, String roomId) throws SQLException {
        try (var statement = connection.prepareStatement(
            "SELECT event_sequence FROM board_game_state WHERE room_id = ?"
        )) {
            statement.setString(1, roomId);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) throw new SQLException("runtime sequence is missing: " + roomId);
                return rows.getLong(1);
            }
        }
    }

    private static List<MutablePlayer> loadPlayerStates(Connection connection, String roomId) throws SQLException {
        var result = new ArrayList<MutablePlayer>();
        try (var statement = connection.prepareStatement("""
            SELECT ps.player_index, ps.soop_id, ps.position, ps.laps,
                   ps.skip_next_throws, p.display_name
            FROM board_game_player_state ps
            JOIN board_room_player p
              ON p.room_id = ps.room_id
             AND p.player_index = ps.player_index
            WHERE ps.room_id = ?
            ORDER BY ps.player_index ASC
            """)) {
            statement.setString(1, roomId);
            try (var rows = statement.executeQuery()) {
                while (rows.next()) {
                    result.add(new MutablePlayer(
                        roomId,
                        rows.getInt("player_index"),
                        rows.getString("soop_id"),
                        rows.getString("display_name"),
                        rows.getInt("position"),
                        rows.getInt("laps"),
                        rows.getInt("skip_next_throws")
                    ));
                }
            }
        }
        return result;
    }

    private static void persistPlayerState(
        Connection connection,
        MutablePlayer player,
        String updatedAt
    ) throws SQLException {
        try (var statement = connection.prepareStatement("""
            UPDATE board_game_player_state
            SET position = ?, laps = ?, skip_next_throws = ?, updated_at = ?
            WHERE room_id = ? AND player_index = ?
            """)) {
            statement.setInt(1, player.position);
            statement.setInt(2, player.laps);
            statement.setInt(3, player.skipNextThrows);
            statement.setString(4, updatedAt);
            statement.setString(5, player.roomId);
            statement.setInt(6, player.playerIndex);
            statement.executeUpdate();
        }
    }

    private static void persistRuntimeBoard(
        Connection connection,
        String roomId,
        BoardPreview board,
        long sequence,
        String updatedAt
    ) throws SQLException {
        try (var statement = connection.prepareStatement("""
            UPDATE board_game_state
            SET board_json = ?, event_sequence = ?, updated_at = ?
            WHERE room_id = ?
            """)) {
            statement.setString(1, GSON.toJson(board));
            statement.setLong(2, sequence);
            statement.setString(3, updatedAt);
            statement.setString(4, roomId);
            statement.executeUpdate();
        }
    }

    private static BoardTurnEvent findDuplicate(
        Connection connection,
        String roomId,
        String fingerprint
    ) throws SQLException {
        try (var statement = connection.prepareStatement("""
            SELECT payload_json
            FROM board_game_event
            WHERE room_id = ? AND source_fingerprint = ?
            LIMIT 1
            """)) {
            statement.setString(1, roomId);
            statement.setString(2, fingerprint);
            try (var rows = statement.executeQuery()) {
                return rows.next()
                    ? GSON.fromJson(rows.getString(1), BoardTurnEvent.class)
                    : null;
            }
        }
    }

    private static void insertEvent(
        Connection connection,
        BoardTurnEvent event,
        String fingerprint,
        String donorId,
        int balloonCount
    ) throws SQLException {
        try (var statement = connection.prepareStatement("""
            INSERT INTO board_game_event(
                event_id, room_id, event_sequence, source_fingerprint,
                source_donor_id, source_balloon_count, event_type,
                payload_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'board.turn', ?, ?)
            """)) {
            statement.setString(1, event.eventId());
            statement.setString(2, event.roomId());
            statement.setLong(3, event.sequence());
            statement.setString(4, fingerprint);
            statement.setString(5, donorId);
            statement.setInt(6, balloonCount);
            statement.setString(7, GSON.toJson(event));
            statement.setString(8, event.createdAt());
            statement.executeUpdate();
        }
    }

    private ThrowOutcome roll(MovementConfig movement) {
        if ("yut".equals(movement.generator())) {
            boolean[] flat = new boolean[4];
            int flatCount = 0;
            for (int i = 0; i < flat.length; i++) {
                flat[i] = nextInt(2) == 1;
                if (flat[i]) flatCount += 1;
            }

            String name;
            if (flatCount == 0) name = "MO";
            else if (flatCount == 4) name = "YUT";
            else if (flatCount == 3) name = "GEOL";
            else if (flatCount == 2) name = "GAE";
            else name = flat[0] ? "BACK_DO" : "DO";

            int steps = switch (name) {
                case "BACK_DO" -> -1;
                case "DO" -> 1;
                case "GAE" -> 2;
                case "GEOL" -> 3;
                case "YUT" -> 4;
                case "MO" -> 5;
                default -> throw new IllegalStateException("unknown yut result");
            };

            boolean bonus = ("YUT".equals(name) && movement.extraThrowOnYut())
                || ("MO".equals(name) && movement.extraThrowOnMo());

            var faces = new ArrayList<YutFace>(4);
            for (int i = 0; i < flat.length; i++) {
                faces.add(new YutFace(flat[i] ? "flat" : "convex", i == 0));
            }

            return new ThrowOutcome(
                steps,
                bonus,
                null,
                new YutResult(name, steps, List.copyOf(faces))
            );
        }

        int count = Math.max(1, Math.min(2, movement.diceCount()));
        var values = new ArrayList<Integer>(count);
        int total = 0;
        for (int i = 0; i < count; i++) {
            int value = nextInt(6) + 1;
            values.add(value);
            total += value;
        }
        boolean isDouble = count == 2 && values.get(0).equals(values.get(1));
        boolean bonus = isDouble && movement.extraThrowOnDouble();
        return new ThrowOutcome(
            total,
            bonus,
            new DiceResult(List.copyOf(values), total, isDouble),
            null
        );
    }

    private LandingChainResult resolveLandingChain(
        RoomContext room,
        MutableBoard board,
        List<MutablePlayer> players,
        MutablePlayer player,
        int pendingBonusThrows,
        List<CellUpdate> updates
    ) {
        var landings = new ArrayList<LandingResolution>();
        boolean safetyStopped = false;

        for (int depth = 0; depth < MAX_LANDING_CHAIN; depth++) {
            CellState landingCell = board.cells().get(player.position);
            JsonElement landingAction = landingCell.action() == null
                ? null
                : landingCell.action().deepCopy();

            String type = actionType(landingAction);
            Integer actionMoveSteps = null;

            if ("skipThrow".equals(type)) {
                player.skipNextThrows += positiveInt(landingAction, "count", 1);
            } else if ("extraThrow".equals(type)) {
                pendingBonusThrows += positiveInt(landingAction, "count", 1);
            } else if ("move".equals(type)) {
                int moveSteps = resolvedMoveSteps(landingAction);
                if (moveSteps != 0) actionMoveSteps = moveSteps;
            }

            landings.add(new LandingResolution(
                landingCell.index(),
                landingCell.instructionId(),
                landingCell.label(),
                landingAction,
                actionMoveSteps
            ));

            if (actionMoveSteps == null) {
                return new LandingChainResult(
                    List.copyOf(landings),
                    pendingBonusThrows,
                    false
                );
            }

            int actionOrigin = player.position;
            int actionDestination = advancePlayer(
                player,
                actionMoveSteps,
                room.config().board().cellCount()
            );

            if (actionOrigin != actionDestination) {
                rerollIfVacated(
                    room,
                    board,
                    players,
                    actionOrigin,
                    updates
                );
            }

            if (actionOrigin == actionDestination) {
                return new LandingChainResult(
                    List.copyOf(landings),
                    pendingBonusThrows,
                    false
                );
            }
        }

        safetyStopped = true;
        return new LandingChainResult(
            List.copyOf(landings),
            pendingBonusThrows,
            safetyStopped
        );
    }

    private void rerollIfVacated(
        RoomContext room,
        MutableBoard board,
        List<MutablePlayer> players,
        int cellIndex,
        List<CellUpdate> updates
    ) {
        if (cellIndex <= 0 || cellIndex >= board.cells().size()) return;
        if (players.stream().anyMatch(player -> player.position == cellIndex)) return;

        CellState current = board.cells().get(cellIndex);
        if (current.locked() || !current.rerollOnVacate()) return;
        if (board.rerollPool() == null || board.rerollPool().isEmpty()) return;

        var instructionById = new LinkedHashMap<String, InstructionInput>();
        for (var instruction : room.config().instructions()) {
            instructionById.put(instruction.id(), instruction);
        }

        var candidates = new ArrayList<RandomPoolEntry>();
        double totalWeight = 0.0d;
        for (var entry : board.rerollPool()) {
            if (entry == null || entry.weight() <= 0.0d) continue;
            if (!instructionById.containsKey(entry.instructionId())) continue;
            if (
                Boolean.FALSE.equals(room.config().randomPool().allowSameInstruction())
                && entry.instructionId().equals(current.instructionId())
            ) {
                continue;
            }
            candidates.add(entry);
            totalWeight += entry.weight();
        }

        if (candidates.isEmpty() || totalWeight <= 0.0d) return;

        double pick = (nextInt(1_000_000) / 1_000_000.0d) * totalWeight;
        RandomPoolEntry selected = candidates.get(candidates.size() - 1);
        double cursor = 0.0d;
        for (var candidate : candidates) {
            cursor += candidate.weight();
            if (pick < cursor) {
                selected = candidate;
                break;
            }
        }

        var definition = instructionById.get(selected.instructionId());
        var replacement = new CellState(
            cellIndex,
            "INSTRUCTION",
            definition.id(),
            definition.label(),
            resolveAction(definition.action()),
            Boolean.TRUE.equals(definition.rerollOnVacate()),
            false
        );
        board.cells().set(cellIndex, replacement);
        updates.add(new CellUpdate(cellIndex, current, replacement, "VACATED"));
    }

    private JsonElement resolveAction(JsonElement action) {
        if (action == null || action.isJsonNull() || !action.isJsonObject()) {
            return action == null ? null : action.deepCopy();
        }

        JsonObject resolved = action.deepCopy().getAsJsonObject();
        JsonElement stepsElement = resolved.get("steps");
        if (stepsElement == null || !stepsElement.isJsonObject()) return resolved;

        JsonObject steps = stepsElement.getAsJsonObject();
        String mode = text(steps, "mode");
        if (!"range".equalsIgnoreCase(mode)) return resolved;

        int min = intValue(steps, "min", 0);
        int max = intValue(steps, "max", 0);
        if (min <= 0 || max < min) return resolved;

        int value = min == max ? min : min + nextInt(max - min + 1);
        resolved.addProperty("resolvedSteps", value);
        return resolved;
    }

    private static String actionType(JsonElement action) {
        if (action == null || !action.isJsonObject()) return "";
        return text(action.getAsJsonObject(), "type");
    }

    private static int resolvedMoveSteps(JsonElement actionElement) {
        if (actionElement == null || !actionElement.isJsonObject()) return 0;
        JsonObject action = actionElement.getAsJsonObject();
        JsonElement stepsElement = action.get("steps");
        int magnitude = intValue(action, "resolvedSteps", 0);

        if (magnitude <= 0 && stepsElement != null && stepsElement.isJsonObject()) {
            JsonObject steps = stepsElement.getAsJsonObject();
            if ("fixed".equalsIgnoreCase(text(steps, "mode"))) {
                magnitude = intValue(steps, "value", 0);
            }
        }

        if (magnitude <= 0) return 0;
        return "backward".equalsIgnoreCase(text(action, "direction"))
            ? -magnitude
            : magnitude;
    }

    private static int positiveInt(JsonElement element, String key, int fallback) {
        if (element == null || !element.isJsonObject()) return fallback;
        return Math.max(1, intValue(element.getAsJsonObject(), key, fallback));
    }

    private static String text(JsonObject object, String key) {
        try {
            JsonElement value = object.get(key);
            return value != null && !value.isJsonNull() ? value.getAsString() : "";
        } catch (RuntimeException ignored) {
            return "";
        }
    }

    private static int intValue(JsonObject object, String key, int fallback) {
        try {
            JsonElement value = object.get(key);
            return value != null && !value.isJsonNull() ? value.getAsInt() : fallback;
        } catch (RuntimeException ignored) {
            return fallback;
        }
    }

    private static int advancePlayer(MutablePlayer player, int steps, int cellCount) {
        int start = player.position;
        if (steps > 0) {
            long absolute = (long) start + steps;
            player.laps += (int) (absolute / cellCount);
        }
        player.position = Math.floorMod(start + steps, cellCount);
        return player.position;
    }

    private int nextInt(int bound) {
        if (bound <= 0) throw new IllegalArgumentException("random bound must be positive");
        int value = randomInt.applyAsInt(bound);
        if (value < 0 || value >= bound) {
            throw new IllegalStateException("random source returned out-of-range value");
        }
        return value;
    }

    private static MutableBoard mutableBoard(BoardPreview source) {
        return new MutableBoard(
            source.seed(),
            source.cellCount(),
            source.layoutStyle(),
            new ArrayList<>(source.cells()),
            source.rerollPool() == null ? List.of() : List.copyOf(source.rerollPool())
        );
    }

    private static String fingerprint(SoopDonation donation) throws SQLException {
        String explicitEventId = extractSoopEventId(donation.rawPayload());
        if (explicitEventId != null) {
            return "event:" + explicitEventId;
        }

        try {
            String material = String.valueOf(donation.streamerId()) + "\u0000"
                + donation.donorId() + "\u0000"
                + donation.balloonCount() + "\u0000"
                + donation.fanOrder() + "\u0000"
                + String.valueOf(donation.rawPayload()) + "\u0000"
                + donation.receivedAtEpochMs();
            byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest(material.getBytes(StandardCharsets.UTF_8));
            return "fingerprint:" + HexFormat.of().formatHex(digest);
        } catch (Exception error) {
            throw new SQLException("failed to calculate board donation fingerprint", error);
        }
    }

    private static String extractSoopEventId(String rawPayload) {
        if (rawPayload == null || rawPayload.isBlank()) return null;

        try {
            JsonElement parsed = JsonParser.parseString(rawPayload);
            if (!parsed.isJsonObject()) return null;

            JsonObject root = parsed.getAsJsonObject();
            var objects = new ArrayList<JsonObject>();
            objects.add(root);

            for (String container : List.of("data", "payload", "body", "event", "message")) {
                JsonElement nested = root.get(container);
                if (nested != null && nested.isJsonObject()) {
                    objects.add(nested.getAsJsonObject());
                }
            }

            for (JsonObject object : objects) {
                for (String key : List.of(
                    "event_id",
                    "eventId",
                    "message_id",
                    "messageId",
                    "msg_id",
                    "msgId",
                    "transaction_id",
                    "transactionId"
                )) {
                    JsonElement value = object.get(key);
                    if (value == null || value.isJsonNull() || !value.isJsonPrimitive()) continue;
                    String text = value.getAsString();
                    if (text != null && !text.isBlank()) return text.trim();
                }
            }
        } catch (RuntimeException ignored) {
            // The SOOP library does not guarantee JSON raw payloads.
        }

        return null;
    }

    private static void validateDonation(SoopDonation donation) {
        Objects.requireNonNull(donation, "donation");
        if (donation.donorId() == null || donation.donorId().isBlank()) {
            throw new IllegalArgumentException("donorId is required");
        }
        if (donation.balloonCount() <= 0) {
            throw new IllegalArgumentException("balloonCount must be positive");
        }
    }

    private static String shortUuid() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 8);
    }

    private record RoomContext(
        String roomId,
        NormalizedRoomConfig config,
        BoardPreview committedBoard
    ) {}

    private record RoomProcessResult(boolean duplicate, BoardTurnEvent event) {}

    private record ThrowOutcome(
        int steps,
        boolean bonusThrow,
        DiceResult dice,
        YutResult yut
    ) {}

    private record LandingChainResult(
        List<LandingResolution> landings,
        int pendingBonusThrows,
        boolean safetyStopped
    ) {}

    private record MutableBoard(
        long seed,
        int cellCount,
        String layoutStyle,
        ArrayList<CellState> cells,
        List<RandomPoolEntry> rerollPool
    ) {}

    private static final class MutablePlayer {
        private final String roomId;
        private final int playerIndex;
        private final String soopId;
        private final String displayName;
        private int position;
        private int laps;
        private int skipNextThrows;

        private MutablePlayer(
            String roomId,
            int playerIndex,
            String soopId,
            String displayName,
            int position,
            int laps,
            int skipNextThrows
        ) {
            this.roomId = roomId;
            this.playerIndex = playerIndex;
            this.soopId = soopId;
            this.displayName = displayName;
            this.position = position;
            this.laps = laps;
            this.skipNextThrows = skipNextThrows;
        }

        private RuntimePlayer snapshot() {
            return new RuntimePlayer(
                playerIndex,
                soopId,
                displayName,
                position,
                laps,
                skipNextThrows
            );
        }
    }

    public record DiceResult(
        List<Integer> values,
        int total,
        boolean isDouble
    ) {}

    public record YutFace(
        String face,
        boolean special
    ) {}

    public record YutResult(
        String name,
        int steps,
        List<YutFace> faces
    ) {}

    public record LandingResolution(
        int cellIndex,
        String instructionId,
        String label,
        JsonElement action,
        Integer actionMoveSteps
    ) {}

    public record CellUpdate(
        int cellIndex,
        CellState previous,
        CellState current,
        String reason
    ) {}

    public record ResolvedThrow(
        int index,
        String generator,
        DiceResult dice,
        YutResult yut,
        int steps,
        int startPosition,
        int throwLandingPosition,
        int endPosition,
        boolean bonusGranted,
        boolean nextThrowScheduled,
        boolean bonusConsumedBySkip,
        LandingResolution landing,
        List<LandingResolution> landingChain,
        List<CellUpdate> cellUpdates,
        int skipNextThrowsAfter
    ) {}

    public record BoardTurnEvent(
        String type,
        String eventId,
        String roomId,
        long sequence,
        String donorId,
        String donorNickname,
        int balloonCount,
        String playerId,
        String playerName,
        String generator,
        int startPosition,
        int endPosition,
        int laps,
        boolean openingThrowSkipped,
        int skipNextThrowsAfter,
        boolean safetyStopped,
        List<ResolvedThrow> throwResolutions,
        List<CellUpdate> cellUpdates,
        String createdAt
    ) {}

    public record RuntimePlayer(
        int playerIndex,
        String soopId,
        String displayName,
        int position,
        int laps,
        int skipNextThrows
    ) {}

    public record RuntimeSnapshot(
        String roomId,
        long sequence,
        BoardPreview board,
        List<RuntimePlayer> players
    ) {}

    public record ProcessResult(
        int matchedRooms,
        int processedRooms,
        int duplicateRooms,
        List<BoardTurnEvent> events
    ) {}
}
