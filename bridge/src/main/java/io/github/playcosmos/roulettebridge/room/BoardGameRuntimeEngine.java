package io.github.playcosmos.roulettebridge.room;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.github.playcosmos.roulettebridge.db.DatabaseAccess;
import io.github.playcosmos.roulettebridge.soop.SoopDonation;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
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

    private final DatabaseAccess database;
    private final Consumer<BoardTurnEvent> eventSink;
    private final IntUnaryOperator randomInt;

    public BoardGameRuntimeEngine(
        DatabaseAccess database,
        Consumer<BoardTurnEvent> eventSink
    ) {
        this(database, eventSink, new SecureRandom()::nextInt);
    }

    BoardGameRuntimeEngine(
        DatabaseAccess database,
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
        var matches = findMatchingRooms(donation.donorId(), donation.balloonCount());

        var events = new ArrayList<BoardTurnEvent>();
        int duplicateRooms = 0;
        int queuedRooms = 0;
        int ignoredRooms = 0;

        for (var match : matches) {
            if ("PAUSED".equals(match.lifecycleState())) {
                var deferred = deferPausedDonation(match, donation, fingerprint);
                if ("DUPLICATE".equals(deferred)) duplicateRooms += 1;
                else if ("QUEUED".equals(deferred)) queuedRooms += 1;
                else if ("IGNORED".equals(deferred)) ignoredRooms += 1;
                continue;
            }

            var backlog = drainQueuedDonations(match.roomId());
            events.addAll(backlog.events());
            duplicateRooms += backlog.duplicateCount();

            if (existsDeferred(match.roomId(), fingerprint)) {
                duplicateRooms += 1;
                continue;
            }

            var result = processRoom(match.roomId(), donation, fingerprint);
            if (result.duplicate()) {
                duplicateRooms += 1;
            } else if (result.event() != null) {
                events.add(result.event());
            }
        }

        dispatchEvents(events);

        return new ProcessResult(
            matches.size(),
            events.size(),
            duplicateRooms,
            queuedRooms,
            ignoredRooms,
            List.copyOf(events)
        );
    }

    public synchronized BoardTurnEvent manualTurn(
        String roomId,
        String soopId
    ) throws SQLException {
        String normalizedRoomId = roomId == null ? "" : roomId.trim();
        String normalizedSoopId = soopId == null ? "" : soopId.trim();

        if (normalizedRoomId.isBlank()) {
            throw new IllegalArgumentException("roomId is required");
        }
        if (normalizedSoopId.isBlank()) {
            throw new IllegalArgumentException("soopId is required");
        }

        String displayName;
        int balloonTrigger;

        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT p.display_name, p.balloon_trigger
                 FROM board_room br
                 JOIN board_room_player p ON p.room_id = br.room_id
                 WHERE br.room_id = ?
                   AND p.soop_id = ?
                   AND br.status = 'READY'
                   AND br.lifecycle_state IN ('ACTIVE', 'PAUSED')
                   AND br.expires_at IS NOT NULL
                   AND datetime(br.expires_at) > datetime('now')
                 LIMIT 1
                 """)) {
            statement.setString(1, normalizedRoomId);
            statement.setString(2, normalizedSoopId);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) {
                    throw new IllegalStateException(
                        "manual turn is unavailable for this player or room state"
                    );
                }
                displayName = rows.getString("display_name");
                balloonTrigger = rows.getInt("balloon_trigger");
            }
        }

        String manualEventId = "manual-turn-" + UUID.randomUUID();
        var donation = new SoopDonation(
            "operator",
            normalizedSoopId,
            displayName,
            balloonTrigger,
            0,
            "{\"event_id\":\"" + manualEventId
                + "\",\"source\":\"operator\"}",
            System.currentTimeMillis()
        );

        var result = processRoom(
            normalizedRoomId,
            donation,
            "event:" + manualEventId,
            false
        );

        if (result.duplicate() || result.event() == null) {
            throw new IllegalStateException("manual turn was not created");
        }

        dispatchEvents(List.of(result.event()));
        return result.event();
    }

    public synchronized BoardTurnEvent setPlayerPosition(
        String roomId,
        String soopId,
        int cellIndex
    ) throws SQLException {
        String normalizedRoomId = roomId == null ? "" : roomId.trim();
        String normalizedSoopId = soopId == null ? "" : soopId.trim();

        if (normalizedRoomId.isBlank()) {
            throw new IllegalArgumentException("roomId is required");
        }
        if (normalizedSoopId.isBlank()) {
            throw new IllegalArgumentException("soopId is required");
        }

        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                var room = loadRoom(connection, normalizedRoomId, false);
                ensureRuntimeState(connection, room);

                var board = loadRuntimeBoard(connection, normalizedRoomId);
                if (cellIndex < 0 || cellIndex >= board.cellCount()) {
                    throw new IllegalArgumentException(
                        "cellIndex must be 0~" + (board.cellCount() - 1)
                    );
                }

                var players = loadPlayerStates(connection, normalizedRoomId);
                var player = players.stream()
                    .filter(value -> value.soopId.equals(normalizedSoopId))
                    .findFirst()
                    .orElseThrow(() -> new IllegalArgumentException(
                        "player is not part of this room"
                    ));

                int startPosition = player.position;
                player.position = cellIndex;

                long sequence = readRuntimeSequence(
                    connection,
                    normalizedRoomId
                ) + 1;
                String createdAt = Instant.now().toString();
                String eventId = "BGP" + Instant.now().toEpochMilli()
                    + "-" + shortUuid();

                persistPlayerState(connection, player, createdAt);
                persistRuntimeBoard(
                    connection,
                    normalizedRoomId,
                    board,
                    sequence,
                    createdAt
                );

                var event = new BoardTurnEvent(
                    "board.turn",
                    eventId,
                    normalizedRoomId,
                    sequence,
                    "operator",
                    "운영자",
                    0,
                    player.soopId,
                    player.displayName,
                    "manual-position",
                    startPosition,
                    player.position,
                    player.laps,
                    false,
                    player.skipNextThrows,
                    false,
                    List.of(),
                    List.of(),
                    createdAt
                );

                insertEvent(
                    connection,
                    event,
                    "operator-position:" + UUID.randomUUID(),
                    "operator",
                    0
                );

                connection.commit();
                dispatchEvents(List.of(event));
                return event;
            } catch (IllegalArgumentException | IllegalStateException error) {
                connection.rollback();
                throw error;
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sqlError) throw sqlError;
                throw new SQLException(
                    "failed to set manual player position",
                    error
                );
            } finally {
                connection.setAutoCommit(true);
            }
        }
    }

    public synchronized void terminateRoom(String roomId) throws SQLException {
        String now = Instant.now().toString();
        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                try (var statement = connection.prepareStatement("""
                    UPDATE board_room
                    SET lifecycle_state = 'TERMINATED',
                        pause_requested_at = NULL,
                        pause_grace_until = NULL,
                        terminated_at = COALESCE(terminated_at, ?),
                        updated_at = ?
                    WHERE room_id = ?
                      AND lifecycle_state <> 'TERMINATED'
                    """)) {
                    statement.setString(1, now);
                    statement.setString(2, now);
                    statement.setString(3, roomId);
                    statement.executeUpdate();
                }

                try (var statement = connection.prepareStatement("""
                    UPDATE board_game_deferred_donation
                    SET state = 'IGNORED'
                    WHERE room_id = ? AND state = 'QUEUED'
                    """)) {
                    statement.setString(1, roomId);
                    statement.executeUpdate();
                }

                connection.commit();
            } catch (SQLException error) {
                connection.rollback();
                throw error;
            } finally {
                connection.setAutoCommit(true);
            }
        }
    }

    public synchronized void pauseRoom(
        String roomId,
        String donationMode,
        Integer requestedGraceSeconds
    ) throws SQLException {
        String mode = donationMode == null
            ? null
            : donationMode.trim().toUpperCase();
        if (
            mode != null
            && !"QUEUE".equals(mode)
            && !"IGNORE".equals(mode)
        ) {
            throw new IllegalArgumentException("donationMode must be QUEUE or IGNORE");
        }
        if (
            requestedGraceSeconds != null
            && (requestedGraceSeconds < 0
                || requestedGraceSeconds > RoomService.MAX_PAUSE_GRACE_SECONDS)
        ) {
            throw new IllegalArgumentException(
                "graceSeconds must be 0~" + RoomService.MAX_PAUSE_GRACE_SECONDS
            );
        }

        try (var connection = database.open()) {
            int configuredGrace = RoomService.DEFAULT_PAUSE_GRACE_SECONDS;
            try (var select = connection.prepareStatement("""
                SELECT pause_grace_seconds
                FROM board_room
                WHERE room_id = ?
                """)) {
                select.setString(1, roomId);
                try (var rows = select.executeQuery()) {
                    if (!rows.next()) {
                        throw new IllegalStateException("room not found: " + roomId);
                    }
                    configuredGrace = rows.getInt(1);
                }
            }

            int graceSeconds = requestedGraceSeconds == null
                ? configuredGrace
                : requestedGraceSeconds;
            Instant pauseAt = Instant.now();
            Instant graceUntil = pauseAt.plusSeconds(graceSeconds);

            try (var statement = connection.prepareStatement("""
                UPDATE board_room
                SET lifecycle_state = 'PAUSED',
                    pause_donation_mode = COALESCE(?, pause_donation_mode),
                    pause_grace_seconds = ?,
                    pause_requested_at = ?,
                    pause_grace_until = ?,
                    updated_at = ?
                WHERE room_id = ?
                  AND status = 'READY'
                  AND lifecycle_state = 'ACTIVE'
                  AND expires_at IS NOT NULL
                  AND datetime(expires_at) > datetime('now')
                """)) {
                statement.setString(1, mode);
                statement.setInt(2, graceSeconds);
                statement.setString(3, pauseAt.toString());
                statement.setString(4, graceUntil.toString());
                statement.setString(5, pauseAt.toString());
                statement.setString(6, roomId);
                if (statement.executeUpdate() != 1) {
                    throw new IllegalStateException("room is not pausable or has expired");
                }
            }
        }
    }

    public synchronized ResumeResult resumeRoom(String roomId) throws SQLException {
        var events = new ArrayList<BoardTurnEvent>();
        int duplicateCount = 0;

        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 UPDATE board_room
                 SET lifecycle_state = 'ACTIVE',
                     pause_requested_at = NULL,
                     pause_grace_until = NULL,
                     updated_at = ?
                 WHERE room_id = ?
                   AND status = 'READY'
                   AND lifecycle_state = 'PAUSED'
                   AND expires_at IS NOT NULL
                   AND datetime(expires_at) > datetime('now')
                 """)) {
            statement.setString(1, Instant.now().toString());
            statement.setString(2, roomId);
            if (statement.executeUpdate() != 1) {
                throw new IllegalStateException("room is not resumable or has expired");
            }
        }

        var drained = drainQueuedDonations(roomId);
        events.addAll(drained.events());
        duplicateCount += drained.duplicateCount();

        dispatchEvents(events);
        return new ResumeResult(
            roomId,
            events.size(),
            duplicateCount,
            List.copyOf(events)
        );
    }

    public synchronized int recoverQueuedDonations() throws SQLException {
        var roomIds = new ArrayList<String>();
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT DISTINCT q.room_id
                 FROM board_game_deferred_donation q
                 JOIN board_room br ON br.room_id = q.room_id
                 WHERE q.state = 'QUEUED'
                   AND br.status = 'READY'
                   AND br.lifecycle_state = 'ACTIVE'
                   AND br.expires_at IS NOT NULL
                   AND datetime(br.expires_at) > datetime('now')
                 ORDER BY q.room_id
                 """);
             var rows = statement.executeQuery()) {
            while (rows.next()) roomIds.add(rows.getString(1));
        }

        var events = new ArrayList<BoardTurnEvent>();
        int processed = 0;
        for (String roomId : roomIds) {
            var drained = drainQueuedDonations(roomId);
            processed += drained.events().size();
            events.addAll(drained.events());
        }
        dispatchEvents(events);
        return processed;
    }

    private DrainResult drainQueuedDonations(String roomId) throws SQLException {
        var events = new ArrayList<BoardTurnEvent>();
        int duplicateCount = 0;

        for (var deferred : loadQueuedDonations(roomId)) {
            var result = processRoom(
                roomId,
                deferred.donation(),
                deferred.fingerprint()
            );
            if (result.duplicate()) duplicateCount += 1;
            else if (result.event() != null) events.add(result.event());
            deleteDeferredDonation(deferred.id());
        }

        return new DrainResult(List.copyOf(events), duplicateCount);
    }

    private void dispatchEvents(List<BoardTurnEvent> events) {
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
    }

    public synchronized RuntimeSnapshot snapshot(String roomId) throws SQLException {
        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                var room = loadRoom(connection, roomId, false);
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
        return processRoom(roomId, donation, fingerprint, true);
    }

    private RoomProcessResult processRoom(
        String roomId,
        SoopDonation donation,
        String fingerprint,
        boolean requireActive
    ) throws SQLException {
        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                var duplicate = findDuplicate(connection, roomId, fingerprint);
                if (duplicate != null) {
                    connection.rollback();
                    return new RoomProcessResult(true, duplicate);
                }

                var room = loadRoom(connection, roomId, requireActive);
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

                String turnGenerator = room.config().movement().generator();

                if (player.skipNextThrows > 0) {
                    player.skipNextThrows -= 1;
                    openingThrowSkipped = true;
                } else {
                    turnGenerator = selectTurnGenerator(room.config().movement());
                    int pendingBonusThrows = 0;
                    int throwIndex = 0;
                    boolean shouldThrow = true;

                    while (shouldThrow && throwIndex < MAX_BONUS_CHAIN) {
                        throwIndex += 1;
                        int throwStart = player.position;
                        var outcome = roll(room.config().movement(), turnGenerator);
                        int appliedMultiplier = Math.max(1, player.nextThrowMultiplier);
                        player.nextThrowMultiplier = 1;
                        int effectiveSteps = outcome.steps() * appliedMultiplier;

                        int throwLanding = advancePlayer(
                            player,
                            effectiveSteps,
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
                            turnGenerator,
                            outcome.dice(),
                            outcome.yut(),
                            outcome.steps(),
                            appliedMultiplier,
                            effectiveSteps,
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

                        shouldThrow = nextThrowScheduled && !safetyStopped;
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
                    turnGenerator,
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

    private List<RoomMatch> findMatchingRooms(
        String soopId,
        int balloonCount
    ) throws SQLException {
        var rooms = new ArrayList<RoomMatch>();
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT br.room_id, br.lifecycle_state, br.pause_donation_mode,
                        br.pause_grace_until
                 FROM board_room br
                 JOIN board_room_player p ON p.room_id = br.room_id
                 WHERE br.status = 'READY'
                   AND br.lifecycle_state IN ('ACTIVE', 'PAUSED')
                   AND br.expires_at IS NOT NULL
                   AND datetime(br.expires_at) > datetime('now')
                   AND p.soop_id = ?
                   AND p.balloon_trigger = ?
                 ORDER BY br.updated_at DESC, br.created_at DESC
                 """)) {
            statement.setString(1, soopId);
            statement.setInt(2, balloonCount);
            try (var rows = statement.executeQuery()) {
                while (rows.next()) {
                    rooms.add(new RoomMatch(
                        rows.getString("room_id"),
                        rows.getString("lifecycle_state"),
                        rows.getString("pause_donation_mode"),
                        rows.getString("pause_grace_until")
                    ));
                }
            }
        }
        return rooms;
    }

    private String deferPausedDonation(
        RoomMatch room,
        SoopDonation donation,
        String fingerprint
    ) throws SQLException {
        try (var connection = database.open()) {
            if (existsProcessedOrDeferred(connection, room.roomId(), fingerprint)) {
                return "DUPLICATE";
            }

            String state;
            if ("IGNORE".equals(room.pauseDonationMode())) {
                state = "IGNORED";
            } else {
                boolean withinGrace = false;
                if (room.pauseGraceUntil() != null && !room.pauseGraceUntil().isBlank()) {
                    try {
                        withinGrace = !Instant.now().isAfter(
                            Instant.parse(room.pauseGraceUntil())
                        );
                    } catch (java.time.format.DateTimeParseException ignored) {
                        try {
                            withinGrace = !OffsetDateTime.now().isAfter(
                                OffsetDateTime.parse(room.pauseGraceUntil())
                            );
                        } catch (java.time.format.DateTimeParseException ignoredAgain) {
                            withinGrace = false;
                        }
                    }
                }
                state = withinGrace ? "QUEUED" : "IGNORED";
            }

            try (var statement = connection.prepareStatement("""
                INSERT INTO board_game_deferred_donation(
                    room_id, source_fingerprint, state, streamer_id,
                    donor_id, nickname, balloon_count, fan_order,
                    raw_payload, received_at_epoch_ms, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """)) {
                statement.setString(1, room.roomId());
                statement.setString(2, fingerprint);
                statement.setString(3, state);
                statement.setString(4, donation.streamerId());
                statement.setString(5, donation.donorId());
                statement.setString(6, donation.nickname());
                statement.setInt(7, donation.balloonCount());
                statement.setInt(8, donation.fanOrder());
                statement.setString(9, donation.rawPayload());
                statement.setLong(10, donation.receivedAtEpochMs());
                statement.setString(11, Instant.now().toString());
                statement.executeUpdate();
            }

            return state;
        }
    }

    private boolean existsDeferred(
        String roomId,
        String fingerprint
    ) throws SQLException {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT 1
                 FROM board_game_deferred_donation
                 WHERE room_id = ? AND source_fingerprint = ?
                 LIMIT 1
                 """)) {
            statement.setString(1, roomId);
            statement.setString(2, fingerprint);
            try (var rows = statement.executeQuery()) {
                return rows.next();
            }
        }
    }

    private static boolean existsProcessedOrDeferred(
        Connection connection,
        String roomId,
        String fingerprint
    ) throws SQLException {
        try (var statement = connection.prepareStatement("""
            SELECT 1
            FROM (
                SELECT source_fingerprint
                FROM board_game_event
                WHERE room_id = ? AND source_fingerprint = ?
                UNION ALL
                SELECT source_fingerprint
                FROM board_game_deferred_donation
                WHERE room_id = ? AND source_fingerprint = ?
            )
            LIMIT 1
            """)) {
            statement.setString(1, roomId);
            statement.setString(2, fingerprint);
            statement.setString(3, roomId);
            statement.setString(4, fingerprint);
            try (var rows = statement.executeQuery()) {
                return rows.next();
            }
        }
    }

    private List<DeferredDonation> loadQueuedDonations(String roomId) throws SQLException {
        var result = new ArrayList<DeferredDonation>();
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT id, source_fingerprint, streamer_id, donor_id,
                        nickname, balloon_count, fan_order, raw_payload,
                        received_at_epoch_ms
                 FROM board_game_deferred_donation
                 WHERE room_id = ? AND state = 'QUEUED'
                 ORDER BY id ASC
                 """)) {
            statement.setString(1, roomId);
            try (var rows = statement.executeQuery()) {
                while (rows.next()) {
                    result.add(new DeferredDonation(
                        rows.getLong("id"),
                        rows.getString("source_fingerprint"),
                        new SoopDonation(
                            rows.getString("streamer_id"),
                            rows.getString("donor_id"),
                            rows.getString("nickname"),
                            rows.getInt("balloon_count"),
                            rows.getInt("fan_order"),
                            rows.getString("raw_payload"),
                            rows.getLong("received_at_epoch_ms")
                        )
                    ));
                }
            }
        }
        return result;
    }

    private void deleteDeferredDonation(long id) throws SQLException {
        try (var connection = database.open();
             var statement = connection.prepareStatement(
                 "DELETE FROM board_game_deferred_donation WHERE id = ?"
             )) {
            statement.setLong(1, id);
            statement.executeUpdate();
        }
    }

    private static RoomContext loadRoom(
        Connection connection,
        String roomId,
        boolean requireActive
    ) throws SQLException {
        try (var statement = connection.prepareStatement("""
            SELECT status, lifecycle_state, expires_at,
                   config_json, committed_board_json
            FROM board_room
            WHERE room_id = ?
            """)) {
            statement.setString(1, roomId);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) throw new SQLException("room not found: " + roomId);
                if (!"READY".equals(rows.getString("status"))) {
                    throw new SQLException("room is not READY: " + roomId);
                }

                String lifecycleState = rows.getString("lifecycle_state");
                if ("TERMINATED".equals(lifecycleState)) {
                    throw new SQLException("room is terminated: " + roomId);
                }
                if (requireActive && !"ACTIVE".equals(lifecycleState)) {
                    throw new SQLException("room is not active: " + roomId);
                }

                String expiresAt = rows.getString("expires_at");
                if (expiresAt != null) {
                    try {
                        if (!OffsetDateTime.parse(expiresAt).isAfter(OffsetDateTime.now())) {
                            throw new SQLException("room has expired: " + roomId);
                        }
                    } catch (java.time.format.DateTimeParseException ignored) {
                        // Legacy migration values may be SQLite datetime strings.
                    }
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
                   ps.skip_next_throws, ps.next_throw_multiplier,
                   ps.ignore_next_landing_effects, p.display_name
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
                        rows.getInt("skip_next_throws"),
                        rows.getInt("next_throw_multiplier"),
                        rows.getInt("ignore_next_landing_effects")
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
            SET position = ?, laps = ?, skip_next_throws = ?,
                next_throw_multiplier = ?, ignore_next_landing_effects = ?,
                updated_at = ?
            WHERE room_id = ? AND player_index = ?
            """)) {
            statement.setInt(1, player.position);
            statement.setInt(2, player.laps);
            statement.setInt(3, player.skipNextThrows);
            statement.setInt(4, player.nextThrowMultiplier);
            statement.setInt(5, player.ignoreNextLandingEffects);
            statement.setString(6, updatedAt);
            statement.setString(7, player.roomId);
            statement.setInt(8, player.playerIndex);
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

    private String selectTurnGenerator(MovementConfig movement) {
        if (!"mixed".equals(movement.generator())) {
            return movement.generator();
        }
        return nextInt(2) == 0 ? "dice" : "yut";
    }

    private ThrowOutcome roll(MovementConfig movement, String generator) {
        if ("yut".equals(generator)) {
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
            boolean effectIgnored = false;

            if (player.ignoreNextLandingEffects > 0) {
                player.ignoreNextLandingEffects -= 1;
                effectIgnored = true;
            } else if ("skipThrow".equals(type)) {
                player.skipNextThrows += positiveInt(landingAction, "count", 1);
            } else if ("extraThrow".equals(type)) {
                pendingBonusThrows += positiveInt(landingAction, "count", 1);
            } else if ("move".equals(type)) {
                int moveSteps = resolvedMoveSteps(landingAction);
                if (moveSteps != 0) actionMoveSteps = moveSteps;
            } else if ("moveToStart".equals(type)) {
                if (player.position != 0) actionMoveSteps = -player.position;
            } else if ("multiplyNextThrow".equals(type)) {
                player.nextThrowMultiplier = positiveInt(
                    landingAction,
                    "multiplier",
                    2
                );
            } else if ("ignoreNextLanding".equals(type)) {
                player.ignoreNextLandingEffects += positiveInt(
                    landingAction,
                    "count",
                    1
                );
            }

            landings.add(new LandingResolution(
                landingCell.index(),
                landingCell.instructionId(),
                landingCell.label(),
                landingAction,
                actionMoveSteps,
                effectIgnored
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
            var candidateDefinition = instructionById.get(entry.instructionId());
            if ("randomCell".equals(actionType(candidateDefinition.action()))) continue;
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
            current.rerollOnVacate(),
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

    private record RoomMatch(
        String roomId,
        String lifecycleState,
        String pauseDonationMode,
        String pauseGraceUntil
    ) {}

    private record DeferredDonation(
        long id,
        String fingerprint,
        SoopDonation donation
    ) {}

    private record DrainResult(
        List<BoardTurnEvent> events,
        int duplicateCount
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
        private int nextThrowMultiplier;
        private int ignoreNextLandingEffects;

        private MutablePlayer(
            String roomId,
            int playerIndex,
            String soopId,
            String displayName,
            int position,
            int laps,
            int skipNextThrows,
            int nextThrowMultiplier,
            int ignoreNextLandingEffects
        ) {
            this.roomId = roomId;
            this.playerIndex = playerIndex;
            this.soopId = soopId;
            this.displayName = displayName;
            this.position = position;
            this.laps = laps;
            this.skipNextThrows = skipNextThrows;
            this.nextThrowMultiplier = Math.max(1, nextThrowMultiplier);
            this.ignoreNextLandingEffects = Math.max(0, ignoreNextLandingEffects);
        }

        private RuntimePlayer snapshot() {
            return new RuntimePlayer(
                playerIndex,
                soopId,
                displayName,
                position,
                laps,
                skipNextThrows,
                nextThrowMultiplier,
                ignoreNextLandingEffects
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
        Integer actionMoveSteps,
        boolean effectIgnored
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
        int rawSteps,
        int appliedMultiplier,
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
        int skipNextThrows,
        int nextThrowMultiplier,
        int ignoreNextLandingEffects
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
        int queuedRooms,
        int ignoredRooms,
        List<BoardTurnEvent> events
    ) {}

    public record ResumeResult(
        String roomId,
        int processedQueuedDonations,
        int duplicateQueuedDonations,
        List<BoardTurnEvent> events
    ) {}
}
