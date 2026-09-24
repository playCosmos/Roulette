package io.github.playcosmos.roulettebridge.room;

import com.google.gson.Gson;
import io.github.playcosmos.roulettebridge.db.BridgeDatabase;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

import static io.github.playcosmos.roulettebridge.room.RoomModels.*;

public final class RoomService {
    private static final Gson GSON = new Gson();
    private static final int MIN_COLUMNS = 8;
    private static final int MAX_COLUMNS = 64;
    private static final int MIN_ROWS = 6;
    private static final int MAX_ROWS = 48;
    private static final int MAX_PLAYERS = 6;
    private static final double TARGET_GRID_RATIO = 4.0d / 3.0d;

    private final BridgeDatabase database;
    private final RoomLayoutGenerator layoutGenerator = new RoomLayoutGenerator();

    public RoomService(BridgeDatabase database) {
        this.database = database;
    }

    public ValidationResult validate(CreateRoomRequest request) {
        var errors = new ArrayList<ValidationError>();
        if (request == null) {
            errors.add(new ValidationError("request", "room request is required"));
            return new ValidationResult(null, errors);
        }

        String name = normalizeText(request.name(), "Room");
        List<PlayerInput> players = normalizePlayers(request.players(), errors);
        BoardConfig board = normalizeBoard(request.board(), errors);
        MovementConfig movement = normalizeMovement(request.movement(), errors);
        List<InstructionInput> instructions = normalizeInstructions(
            request.instructions(),
            board == null ? 0 : board.cellCount() - 1,
            errors
        );
        RandomPoolConfig randomPool = normalizeRandomPool(
            request.randomPool(),
            instructions,
            errors
        );

        var config = board == null || movement == null
            ? null
            : new NormalizedRoomConfig(
                name,
                List.copyOf(players),
                board,
                movement,
                List.copyOf(instructions),
                randomPool
            );

        return new ValidationResult(config, List.copyOf(errors));
    }

    public RoomSnapshot create(CreateRoomRequest request) throws SQLException {
        var validation = validate(request);
        if (!validation.valid()) {
            throw new RoomValidationException(validation.errors());
        }

        var config = validation.config();
        String roomId = UUID.randomUUID().toString();
        long seed = nextSeed();
        var preview = layoutGenerator.generate(config, seed);
        String now = OffsetDateTime.now().toString();

        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                try (var statement = connection.prepareStatement("""
                    INSERT INTO board_room(
                        room_id, name, status, config_json, preview_json,
                        committed_board_json, preview_seed, created_at, updated_at
                    ) VALUES (?, ?, 'DRAFT', ?, ?, NULL, ?, ?, ?)
                    """)) {
                    statement.setString(1, roomId);
                    statement.setString(2, config.name());
                    statement.setString(3, GSON.toJson(config));
                    statement.setString(4, GSON.toJson(preview));
                    statement.setLong(5, seed);
                    statement.setString(6, now);
                    statement.setString(7, now);
                    statement.executeUpdate();
                }

                insertPlayers(connection, roomId, config.players());
                connection.commit();
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sqlError) throw sqlError;
                throw new SQLException("failed to create board room", error);
            } finally {
                connection.setAutoCommit(true);
            }
        }

        return new RoomSnapshot(
            roomId,
            "DRAFT",
            config,
            preview,
            null,
            now,
            now
        );
    }

    public RoomSnapshot find(String roomId) throws SQLException {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT room_id, status, config_json, preview_json,
                        committed_board_json, created_at, updated_at
                 FROM board_room
                 WHERE room_id = ?
                 """)) {
            statement.setString(1, roomId);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) throw new NoSuchElementException("room not found: " + roomId);

                var config = GSON.fromJson(rows.getString("config_json"), NormalizedRoomConfig.class);
                var preview = GSON.fromJson(rows.getString("preview_json"), BoardPreview.class);
                String committedJson = rows.getString("committed_board_json");
                var committed = committedJson == null
                    ? null
                    : GSON.fromJson(committedJson, BoardPreview.class);

                return new RoomSnapshot(
                    rows.getString("room_id"),
                    rows.getString("status"),
                    config,
                    preview,
                    committed,
                    rows.getString("created_at"),
                    rows.getString("updated_at")
                );
            }
        }
    }

    public RoomSnapshot rerollPreview(String roomId) throws SQLException {
        var current = find(roomId);
        if (!"DRAFT".equals(current.status())) {
            throw new IllegalStateException("committed room preview cannot be rerolled");
        }

        long seed = nextSeed();
        var preview = layoutGenerator.generate(current.config(), seed);
        String now = OffsetDateTime.now().toString();

        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 UPDATE board_room
                 SET preview_json = ?, preview_seed = ?, updated_at = ?
                 WHERE room_id = ? AND status = 'DRAFT'
                 """)) {
            statement.setString(1, GSON.toJson(preview));
            statement.setLong(2, seed);
            statement.setString(3, now);
            statement.setString(4, roomId);
            if (statement.executeUpdate() != 1) {
                throw new IllegalStateException("room preview changed concurrently");
            }
        }

        return new RoomSnapshot(
            current.roomId(),
            current.status(),
            current.config(),
            preview,
            current.committedBoard(),
            current.createdAt(),
            now
        );
    }

    public RoomSnapshot commitPreview(String roomId) throws SQLException {
        var current = find(roomId);
        if (!"DRAFT".equals(current.status())) {
            return current;
        }

        String now = OffsetDateTime.now().toString();
        String previewJson = GSON.toJson(current.preview());

        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 UPDATE board_room
                 SET status = 'READY',
                     committed_board_json = ?,
                     updated_at = ?
                 WHERE room_id = ? AND status = 'DRAFT'
                 """)) {
            statement.setString(1, previewJson);
            statement.setString(2, now);
            statement.setString(3, roomId);
            if (statement.executeUpdate() != 1) {
                throw new IllegalStateException("room preview changed concurrently");
            }
        }

        return new RoomSnapshot(
            current.roomId(),
            "READY",
            current.config(),
            current.preview(),
            current.preview(),
            current.createdAt(),
            now
        );
    }

    private static void insertPlayers(
        java.sql.Connection connection,
        String roomId,
        List<PlayerInput> players
    ) throws SQLException {
        try (var statement = connection.prepareStatement("""
            INSERT INTO board_room_player(
                room_id, player_index, soop_id, display_name,
                profile_image_url, balloon_trigger
            ) VALUES (?, ?, ?, ?, ?, ?)
            """)) {
            for (int i = 0; i < players.size(); i++) {
                var player = players.get(i);
                statement.setString(1, roomId);
                statement.setInt(2, i);
                statement.setString(3, player.soopId());
                statement.setString(4, player.displayName());
                statement.setString(5, player.profileImageUrl());
                statement.setInt(6, player.balloonTrigger());
                statement.addBatch();
            }
            statement.executeBatch();
        }
    }

    private static List<PlayerInput> normalizePlayers(
        List<PlayerInput> source,
        List<ValidationError> errors
    ) {
        var players = source == null ? List.<PlayerInput>of() : source;
        if (players.isEmpty() || players.size() > MAX_PLAYERS) {
            errors.add(new ValidationError("players", "player count must be 1~" + MAX_PLAYERS));
        }

        var normalized = new ArrayList<PlayerInput>();
        var soopIds = new HashSet<String>();

        for (int i = 0; i < Math.min(players.size(), MAX_PLAYERS); i++) {
            var player = players.get(i);
            String prefix = "players[" + i + "]";
            if (player == null) {
                errors.add(new ValidationError(prefix, "player is required"));
                continue;
            }

            String soopId = normalizeText(player.soopId(), "");
            if (soopId.isBlank()) {
                errors.add(new ValidationError(prefix + ".soopId", "SOOP id is required"));
            } else if (!soopIds.add(soopId)) {
                errors.add(new ValidationError(prefix + ".soopId", "SOOP id must be unique in room"));
            }

            if (player.balloonTrigger() <= 0) {
                errors.add(new ValidationError(prefix + ".balloonTrigger", "exact balloon trigger must be > 0"));
            }

            normalized.add(new PlayerInput(
                soopId,
                normalizeText(player.displayName(), soopId),
                blankToNull(player.profileImageUrl()),
                player.balloonTrigger()
            ));
        }

        return normalized;
    }

    private static BoardConfig normalizeBoard(
        BoardInput input,
        List<ValidationError> errors
    ) {
        BoardInput board = input == null
            ? new BoardInput("dimensions", 16, 12, null, "rounded")
            : input;

        String style = normalizeText(board.layoutStyle(), "rounded").toLowerCase();
        if (!Set.of("rounded", "rect").contains(style)) {
            errors.add(new ValidationError("board.layoutStyle", "layoutStyle must be rounded or rect"));
            style = "rounded";
        }

        String sizingMode = normalizeText(board.sizingMode(), "dimensions").toLowerCase();
        int columns;
        int rows;

        if ("cellcount".equals(sizingMode) || "cell_count".equals(sizingMode)) {
            Integer requested = board.cellCount();
            int[] dimensions = requested == null ? null : dimensionsForCellCount(requested);
            if (dimensions == null) {
                errors.add(new ValidationError(
                    "board.cellCount",
                    "cellCount must map to a supported rectangular perimeter"
                ));
                return null;
            }
            columns = dimensions[0];
            rows = dimensions[1];
        } else if ("dimensions".equals(sizingMode)) {
            columns = board.columns() == null ? 16 : board.columns();
            rows = board.rows() == null ? 12 : board.rows();
            if (columns < MIN_COLUMNS || columns > MAX_COLUMNS) {
                errors.add(new ValidationError(
                    "board.columns",
                    "columns must be " + MIN_COLUMNS + "~" + MAX_COLUMNS
                ));
            }
            if (rows < MIN_ROWS || rows > MAX_ROWS) {
                errors.add(new ValidationError(
                    "board.rows",
                    "rows must be " + MIN_ROWS + "~" + MAX_ROWS
                ));
            }
        } else {
            errors.add(new ValidationError(
                "board.sizingMode",
                "sizingMode must be dimensions or cellCount"
            ));
            return null;
        }

        int cellCount = perimeterCellCount(columns, rows);
        return new BoardConfig(columns, rows, cellCount, style);
    }

    private static MovementConfig normalizeMovement(
        MovementInput input,
        List<ValidationError> errors
    ) {
        MovementInput movement = input == null
            ? new MovementInput("dice", 2, true, true, true)
            : input;

        String generator = normalizeText(movement.generator(), "dice").toLowerCase();
        if (!Set.of("dice", "yut").contains(generator)) {
            errors.add(new ValidationError("movement.generator", "generator must be dice or yut"));
            generator = "dice";
        }

        int diceCount = movement.diceCount() == null ? 2 : movement.diceCount();
        if (diceCount < 1 || diceCount > 2) {
            errors.add(new ValidationError("movement.diceCount", "diceCount must be 1 or 2"));
            diceCount = Math.max(1, Math.min(2, diceCount));
        }

        return new MovementConfig(
            generator,
            diceCount,
            6,
            movement.extraThrowOnDouble() == null || movement.extraThrowOnDouble(),
            movement.extraThrowOnYut() == null || movement.extraThrowOnYut(),
            movement.extraThrowOnMo() == null || movement.extraThrowOnMo()
        );
    }

    private static List<InstructionInput> normalizeInstructions(
        List<InstructionInput> source,
        int assignableCells,
        List<ValidationError> errors
    ) {
        var input = source == null ? List.<InstructionInput>of() : source;
        var normalized = new ArrayList<InstructionInput>();
        var ids = new HashSet<String>();
        int countTotal = 0;
        double ratioTotal = 0.0d;

        for (int i = 0; i < input.size(); i++) {
            var instruction = input.get(i);
            String prefix = "instructions[" + i + "]";
            if (instruction == null) {
                errors.add(new ValidationError(prefix, "instruction is required"));
                continue;
            }

            String id = normalizeText(instruction.id(), "");
            if (id.isBlank()) {
                errors.add(new ValidationError(prefix + ".id", "instruction id is required"));
                continue;
            }
            if ("START".equalsIgnoreCase(id) || "NORMAL".equalsIgnoreCase(id)) {
                errors.add(new ValidationError(prefix + ".id", "START and NORMAL are reserved ids"));
                continue;
            }
            if (!ids.add(id)) {
                errors.add(new ValidationError(prefix + ".id", "instruction id must be unique"));
                continue;
            }

            var allocation = instruction.allocation();
            if (allocation == null) {
                errors.add(new ValidationError(prefix + ".allocation", "allocation is required"));
                continue;
            }

            String mode = normalizeText(allocation.mode(), "").toLowerCase();
            double value = allocation.value();
            if ("count".equals(mode)) {
                if (value < 0 || value != Math.rint(value)) {
                    errors.add(new ValidationError(prefix + ".allocation.value", "count must be a non-negative integer"));
                } else {
                    countTotal += (int) value;
                }
            } else if ("ratio".equals(mode)) {
                if (!(value >= 0.0d && value <= 100.0d)) {
                    errors.add(new ValidationError(prefix + ".allocation.value", "ratio must be 0~100"));
                } else {
                    ratioTotal += value;
                }
            } else {
                errors.add(new ValidationError(prefix + ".allocation.mode", "allocation mode must be count or ratio"));
            }

            normalized.add(new InstructionInput(
                id,
                normalizeText(instruction.label(), id),
                new AllocationInput(mode, value),
                Boolean.TRUE.equals(instruction.rerollOnVacate()),
                instruction.action() == null ? null : instruction.action().deepCopy()
            ));
        }

        if (assignableCells > 0 && countTotal > assignableCells) {
            errors.add(new ValidationError(
                "instructions",
                "count allocations exceed non-START cells"
            ));
        }
        if (ratioTotal > 100.000001d) {
            errors.add(new ValidationError(
                "instructions",
                "ratio allocations must total 100 or less"
            ));
        }

        return normalized;
    }

    private static RandomPoolConfig normalizeRandomPool(
        RandomPoolInput input,
        List<InstructionInput> instructions,
        List<ValidationError> errors
    ) {
        var byId = new LinkedHashMap<String, InstructionInput>();
        for (var instruction : instructions) byId.put(instruction.id(), instruction);

        String mode = input == null
            ? "inheritRatioInstructions"
            : normalizeText(input.mode(), "inheritRatioInstructions");

        boolean allowSame = input == null
            || input.allowSameInstruction() == null
            || input.allowSameInstruction();

        var entries = new ArrayList<RandomPoolEntry>();

        if ("inheritRatioInstructions".equalsIgnoreCase(mode)) {
            for (var instruction : instructions) {
                if (!"ratio".equals(instruction.allocation().mode())) continue;
                if (instruction.allocation().value() <= 0.0d) continue;
                entries.add(new RandomPoolEntry(
                    instruction.id(),
                    instruction.allocation().value()
                ));
            }
            mode = "inheritRatioInstructions";
        } else if ("custom".equalsIgnoreCase(mode)) {
            mode = "custom";
            var selected = input.entries() == null
                ? List.<RandomPoolEntry>of()
                : input.entries();
            var seen = new HashSet<String>();

            for (int i = 0; i < selected.size(); i++) {
                var entry = selected.get(i);
                String prefix = "randomPool.entries[" + i + "]";
                if (entry == null || !byId.containsKey(entry.instructionId())) {
                    errors.add(new ValidationError(prefix + ".instructionId", "unknown instruction id"));
                    continue;
                }
                if (!seen.add(entry.instructionId())) {
                    errors.add(new ValidationError(prefix + ".instructionId", "duplicate random pool instruction"));
                    continue;
                }
                if (!(entry.weight() > 0.0d)) {
                    errors.add(new ValidationError(prefix + ".weight", "weight must be > 0"));
                    continue;
                }
                entries.add(new RandomPoolEntry(entry.instructionId(), entry.weight()));
            }
        } else {
            errors.add(new ValidationError(
                "randomPool.mode",
                "random pool mode must be inheritRatioInstructions or custom"
            ));
            mode = "inheritRatioInstructions";
        }

        boolean needsPool = instructions.stream()
            .anyMatch(instruction -> Boolean.TRUE.equals(instruction.rerollOnVacate()));
        if (needsPool && entries.isEmpty()) {
            errors.add(new ValidationError(
                "randomPool",
                "rerollOnVacate requires at least one random pool instruction"
            ));
        }

        return new RandomPoolConfig(mode, List.copyOf(entries), allowSame);
    }

    private static int[] dimensionsForCellCount(int cellCount) {
        if (cellCount < perimeterCellCount(MIN_COLUMNS, MIN_ROWS) || (cellCount & 1) != 0) {
            return null;
        }

        int[] best = null;
        double bestScore = Double.POSITIVE_INFINITY;

        for (int columns = MIN_COLUMNS; columns <= MAX_COLUMNS; columns++) {
            for (int rows = MIN_ROWS; rows <= MAX_ROWS; rows++) {
                if (perimeterCellCount(columns, rows) != cellCount) continue;
                double score = Math.abs(((double) columns / rows) - TARGET_GRID_RATIO);
                if (score < bestScore) {
                    bestScore = score;
                    best = new int[] { columns, rows };
                }
            }
        }
        return best;
    }

    private static int perimeterCellCount(int columns, int rows) {
        return (columns * 2) + ((rows - 2) * 2);
    }

    private static long nextSeed() {
        return ThreadLocalRandom.current().nextLong(Long.MAX_VALUE);
    }

    private static String normalizeText(String value, String fallback) {
        if (value == null) return fallback;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? fallback : trimmed;
    }

    private static String blankToNull(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    public static final class RoomValidationException extends IllegalArgumentException {
        private final List<ValidationError> errors;

        public RoomValidationException(List<ValidationError> errors) {
            super("invalid room configuration");
            this.errors = List.copyOf(errors);
        }

        public List<ValidationError> errors() {
            return errors;
        }
    }
}
