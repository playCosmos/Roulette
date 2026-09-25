package io.github.playcosmos.roulettebridge.room;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import io.github.playcosmos.roulettebridge.db.DatabaseAccess;
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
    public static final int DEFAULT_RETENTION_MINUTES = 240;
    public static final int MAX_RETENTION_MINUTES = 480;
    public static final int DEFAULT_PAUSE_GRACE_SECONDS = 10;
    public static final int MAX_PAUSE_GRACE_SECONDS = 120;
    public static final int EXTENSION_WINDOW_MINUTES = 60;
    public static final int MAX_EXTENSION_MINUTES = 120;
    private static final int MAX_SAFE_LAYOUT_ATTEMPTS = 256;
    private static final double TARGET_GRID_RATIO = 4.0d / 3.0d;

    private final DatabaseAccess database;
    private final RoomLayoutGenerator layoutGenerator = new RoomLayoutGenerator();
    private final FixedInstructionCycleValidator cycleValidator = new FixedInstructionCycleValidator();
    private final ParticipantLiveChecker liveChecker;

    public RoomService(DatabaseAccess database) {
        this(database, new SoopParticipantLiveService());
    }

    public RoomService(DatabaseAccess database, ParticipantLiveChecker liveChecker) {
        this.database = database;
        this.liveChecker = liveChecker;
    }

    public ValidationResult validate(CreateRoomRequest request) {
        var errors = new ArrayList<ValidationError>();
        if (request == null) {
            errors.add(new ValidationError("request", "room request is required"));
            return new ValidationResult(null, errors);
        }

        int retentionMinutes = normalizeRetentionMinutes(request.retentionMinutes(), errors);
        normalizePauseDonationMode(request.pauseDonationMode(), errors);
        normalizePauseGraceSeconds(request.pauseGraceSeconds(), errors);

        String name = normalizeText(request.name(), "Room");
        List<PlayerConfig> players = normalizePlayers(request.players(), errors);
        BoardConfig board = normalizeBoard(request.board(), errors);
        MovementConfig movement = normalizeMovement(request.movement(), errors);
        RulesConfig rules = normalizeRules(request.rules(), errors);
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
                rules,
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
        int retentionMinutes = request.retentionMinutes() == null
            ? DEFAULT_RETENTION_MINUTES
            : request.retentionMinutes();
        String pauseDonationMode = request.pauseDonationMode() == null
            ? "QUEUE"
            : request.pauseDonationMode().trim().toUpperCase();
        int pauseGraceSeconds = request.pauseGraceSeconds() == null
            ? DEFAULT_PAUSE_GRACE_SECONDS
            : request.pauseGraceSeconds();
        var preview = generateSafePreview(config);
        var checkedPlayers = liveChecker.check(config.players());
        config = new NormalizedRoomConfig(
            config.name(),
            checkedPlayers,
            config.board(),
            config.movement(),
            config.rules(),
            config.instructions(),
            config.randomPool()
        );

        String roomId = UUID.randomUUID().toString();
        var createdAt = OffsetDateTime.now();
        String now = createdAt.toString();
        String expiresAt = createdAt.plusMinutes(retentionMinutes).toString();

        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                try (var statement = connection.prepareStatement("""
                    INSERT INTO board_room(
                        room_id, name, status, config_json, preview_json,
                        committed_board_json, preview_seed, created_at, updated_at,
                        lifecycle_state, retention_minutes, expires_at,
                        pause_donation_mode, pause_grace_seconds,
                        pause_requested_at, pause_grace_until, terminated_at
                    ) VALUES (?, ?, 'DRAFT', ?, ?, NULL, ?, ?, ?,
                              'DRAFT', ?, ?, ?, ?, NULL, NULL, NULL)
                    """)) {
                    statement.setString(1, roomId);
                    statement.setString(2, config.name());
                    statement.setString(3, GSON.toJson(config));
                    statement.setString(4, GSON.toJson(preview));
                    statement.setLong(5, preview.seed());
                    statement.setString(6, now);
                    statement.setString(7, now);
                    statement.setInt(8, retentionMinutes);
                    statement.setString(9, expiresAt);
                    statement.setString(10, pauseDonationMode);
                    statement.setInt(11, pauseGraceSeconds);
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
            now,
            new RoomLifecycle(
                "DRAFT",
                retentionMinutes,
                expiresAt,
                pauseDonationMode,
                pauseGraceSeconds,
                null,
                null,
                0,
                null
            )
        );
    }

    public RoomSnapshot find(String roomId) throws SQLException {
        terminateExpiredRooms();

        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT br.room_id, br.status, br.config_json, br.preview_json,
                        br.committed_board_json, br.created_at, br.updated_at,
                        br.lifecycle_state, br.retention_minutes, br.expires_at,
                        br.pause_donation_mode, br.pause_grace_seconds,
                        br.pause_requested_at, br.pause_grace_until,
                        br.terminated_at,
                        (
                          SELECT COUNT(*)
                          FROM board_game_deferred_donation q
                          WHERE q.room_id = br.room_id
                            AND q.state = 'QUEUED'
                        ) AS queued_donations
                 FROM board_room br
                 WHERE br.room_id = ?
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
                    rows.getString("updated_at"),
                    new RoomLifecycle(
                        rows.getString("lifecycle_state"),
                        rows.getInt("retention_minutes"),
                        rows.getString("expires_at"),
                        rows.getString("pause_donation_mode"),
                        rows.getInt("pause_grace_seconds"),
                        rows.getString("pause_requested_at"),
                        rows.getString("pause_grace_until"),
                        rows.getInt("queued_donations"),
                        rows.getString("terminated_at")
                    )
                );
            }
        }
    }

    public RoomSnapshot rerollPreview(String roomId) throws SQLException {
        var current = find(roomId);
        if (
            !"DRAFT".equals(current.status())
            || current.lifecycle() == null
            || !"DRAFT".equals(current.lifecycle().state())
        ) {
            throw new IllegalStateException("room preview cannot be rerolled in current lifecycle state");
        }

        var preview = generateSafePreview(current.config());
        String now = OffsetDateTime.now().toString();

        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 UPDATE board_room
                 SET preview_json = ?, preview_seed = ?, updated_at = ?
                 WHERE room_id = ? AND status = 'DRAFT'
                 """)) {
            statement.setString(1, GSON.toJson(preview));
            statement.setLong(2, preview.seed());
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
            now,
            current.lifecycle()
        );
    }

    public synchronized RoomSnapshot commitPreview(String roomId) throws SQLException {
        var current = find(roomId);
        if (!"DRAFT".equals(current.status())) {
            return current;
        }
        if (
            current.lifecycle() == null
            || !"DRAFT".equals(current.lifecycle().state())
        ) {
            throw new IllegalStateException("terminated room cannot be activated");
        }

        cycleValidator.requireSafe(current.preview());

        String now = OffsetDateTime.now().toString();
        String previewJson = GSON.toJson(current.preview());

        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                String activeRoomId = findActiveRoomId(connection, roomId);
                if (activeRoomId != null) {
                    connection.rollback();
                    throw new IllegalStateException(
                        "another board room is already active: " + activeRoomId
                    );
                }

                try (var statement = connection.prepareStatement("""
                    UPDATE board_room
                    SET status = 'READY',
                        lifecycle_state = 'ACTIVE',
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

                connection.commit();
            } catch (IllegalStateException error) {
                connection.rollback();
                throw error;
            } catch (SQLException error) {
                connection.rollback();
                if (isSingleActiveRoomConstraint(error)) {
                    throw new IllegalStateException(
                        "another board room became active concurrently",
                        error
                    );
                }
                throw error;
            } finally {
                connection.setAutoCommit(true);
            }
        }

        return new RoomSnapshot(
            current.roomId(),
            "READY",
            current.config(),
            current.preview(),
            current.preview(),
            current.createdAt(),
            now,
            new RoomLifecycle(
                "ACTIVE",
                current.lifecycle().retentionMinutes(),
                current.lifecycle().expiresAt(),
                current.lifecycle().pauseDonationMode(),
                current.lifecycle().pauseGraceSeconds(),
                null,
                null,
                current.lifecycle().queuedDonations(),
                null
            )
        );
    }

    public synchronized RoomSnapshot extendLifetime(
        String roomId,
        int additionalMinutes
    ) throws SQLException {
        if (
            additionalMinutes < 1
            || additionalMinutes > MAX_EXTENSION_MINUTES
        ) {
            throw new IllegalArgumentException(
                "additionalMinutes must be 1~" + MAX_EXTENSION_MINUTES
            );
        }

        var current = find(roomId);
        if (
            current.lifecycle() == null
            || "TERMINATED".equals(current.lifecycle().state())
        ) {
            throw new IllegalStateException("terminated room cannot be extended");
        }

        OffsetDateTime now = OffsetDateTime.now();
        OffsetDateTime expiresAt = parseStoredDateTime(
            current.lifecycle().expiresAt()
        );
        if (expiresAt == null || !expiresAt.isAfter(now)) {
            throw new IllegalStateException("expired room cannot be extended");
        }
        if (expiresAt.isAfter(now.plusMinutes(EXTENSION_WINDOW_MINUTES))) {
            throw new IllegalStateException(
                "room lifetime can be extended only within "
                    + EXTENSION_WINDOW_MINUTES + " minutes of expiry"
            );
        }

        OffsetDateTime extendedExpiresAt = expiresAt.plusMinutes(additionalMinutes);
        String updatedAt = now.toString();

        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 UPDATE board_room
                 SET retention_minutes = retention_minutes + ?,
                     expires_at = ?,
                     updated_at = ?
                 WHERE room_id = ?
                   AND lifecycle_state <> 'TERMINATED'
                   AND expires_at IS NOT NULL
                   AND datetime(expires_at) > datetime('now')
                   AND datetime(expires_at) <= datetime('now', '+60 minutes')
                 """)) {
            statement.setInt(1, additionalMinutes);
            statement.setString(2, extendedExpiresAt.toString());
            statement.setString(3, updatedAt);
            statement.setString(4, roomId);
            if (statement.executeUpdate() != 1) {
                throw new IllegalStateException(
                    "room lifetime can be extended only within "
                        + EXTENSION_WINDOW_MINUTES
                        + " minutes of expiry"
                );
            }
        }

        return find(roomId);
    }

    public synchronized RoomSnapshot pause(
        String roomId,
        String requestedDonationMode
    ) throws SQLException {
        var current = find(roomId);
        if (!"READY".equals(current.status())) {
            throw new IllegalStateException("only committed rooms can be paused");
        }
        if (!"ACTIVE".equals(current.lifecycle().state())) {
            throw new IllegalStateException("only active rooms can be paused");
        }

        var modeErrors = new ArrayList<ValidationError>();
        String mode = normalizePauseDonationMode(
            requestedDonationMode == null
                ? current.lifecycle().pauseDonationMode()
                : requestedDonationMode,
            modeErrors
        );
        if (!modeErrors.isEmpty()) {
            throw new RoomValidationException(modeErrors);
        }

        String now = OffsetDateTime.now().toString();
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 UPDATE board_room
                 SET lifecycle_state = 'PAUSED',
                     pause_donation_mode = ?,
                     pause_requested_at = ?,
                     pause_grace_until = ?,
                     updated_at = ?
                 WHERE room_id = ?
                   AND status = 'READY'
                   AND lifecycle_state = 'ACTIVE'
                 """)) {
            var pauseAt = OffsetDateTime.now();
            statement.setString(1, mode);
            statement.setString(2, pauseAt.toString());
            statement.setString(3, pauseAt.plusSeconds(current.lifecycle().pauseGraceSeconds()).toString());
            statement.setString(4, now);
            statement.setString(5, roomId);
            if (statement.executeUpdate() != 1) {
                throw new IllegalStateException("room pause state changed concurrently");
            }
        }
        return find(roomId);
    }

    public synchronized RoomSnapshot terminate(String roomId) throws SQLException {
        var current = find(roomId);
        if ("TERMINATED".equals(current.lifecycle().state())) return current;

        String now = OffsetDateTime.now().toString();
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 UPDATE board_room
                 SET lifecycle_state = 'TERMINATED',
                     pause_requested_at = NULL,
                     pause_grace_until = NULL,
                     terminated_at = ?,
                     updated_at = ?
                 WHERE room_id = ?
                   AND lifecycle_state <> 'TERMINATED'
                 """)) {
            statement.setString(1, now);
            statement.setString(2, now);
            statement.setString(3, roomId);
            statement.executeUpdate();
        }
        return find(roomId);
    }

    public int terminateExpiredRooms() throws SQLException {
        String now = OffsetDateTime.now().toString();
        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                var expiredRoomIds = new ArrayList<String>();
                try (var select = connection.prepareStatement("""
                    SELECT room_id
                    FROM board_room
                    WHERE lifecycle_state <> 'TERMINATED'
                      AND expires_at IS NOT NULL
                      AND datetime(expires_at) <= datetime('now')
                    """);
                     var rows = select.executeQuery()) {
                    while (rows.next()) expiredRoomIds.add(rows.getString(1));
                }

                if (expiredRoomIds.isEmpty()) {
                    connection.commit();
                    return 0;
                }

                int terminated;
                try (var statement = connection.prepareStatement("""
                    UPDATE board_room
                    SET lifecycle_state = 'TERMINATED',
                        terminated_at = COALESCE(terminated_at, ?),
                        updated_at = ?
                    WHERE lifecycle_state <> 'TERMINATED'
                      AND expires_at IS NOT NULL
                      AND datetime(expires_at) <= datetime('now')
                    """)) {
                    statement.setString(1, now);
                    statement.setString(2, now);
                    terminated = statement.executeUpdate();
                }

                try (var statement = connection.prepareStatement("""
                    UPDATE board_game_deferred_donation
                    SET state = 'IGNORED'
                    WHERE state = 'QUEUED'
                      AND room_id = ?
                    """)) {
                    for (String roomId : expiredRoomIds) {
                        statement.setString(1, roomId);
                        statement.addBatch();
                    }
                    statement.executeBatch();
                }

                connection.commit();
                return terminated;
            } catch (SQLException error) {
                connection.rollback();
                throw error;
            } finally {
                connection.setAutoCommit(true);
            }
        }
    }

    private static String findActiveRoomId(
        java.sql.Connection connection,
        String excludedRoomId
    ) throws SQLException {
        try (var statement = connection.prepareStatement("""
            SELECT room_id
            FROM board_room
            WHERE status = 'READY'
              AND lifecycle_state IN ('ACTIVE', 'PAUSED')
              AND room_id <> ?
            ORDER BY updated_at DESC
            LIMIT 1
            """)) {
            statement.setString(1, excludedRoomId);
            try (var rows = statement.executeQuery()) {
                return rows.next() ? rows.getString(1) : null;
            }
        }
    }

    private static boolean isSingleActiveRoomConstraint(SQLException error) {
        String message = error.getMessage();
        return message != null
            && message.contains("UNIQUE constraint failed");
    }

    private static void insertPlayers(
        java.sql.Connection connection,
        String roomId,
        List<PlayerConfig> players
    ) throws SQLException {
        try (var statement = connection.prepareStatement("""
            INSERT INTO board_room_player(
                room_id, player_index, soop_id, display_name,
                profile_image_url, balloon_trigger,
                live_status, live_bno, live_title, live_checked_at, live_check_error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """)) {
            for (int i = 0; i < players.size(); i++) {
                var player = players.get(i);
                statement.setString(1, roomId);
                statement.setInt(2, i);
                statement.setString(3, player.soopId());
                statement.setString(4, player.displayName());
                statement.setString(5, player.profileImageUrl());
                statement.setInt(6, player.balloonTrigger());
                statement.setString(7, player.live() == null ? "NOT_CHECKED" : player.live().status());
                statement.setString(8, player.live() == null ? null : player.live().bno());
                statement.setString(9, player.live() == null ? null : player.live().title());
                statement.setString(10, player.live() == null ? null : player.live().checkedAt());
                statement.setString(11, player.live() == null ? null : player.live().error());
                statement.addBatch();
            }
            statement.executeBatch();
        }
    }

    private static List<PlayerConfig> normalizePlayers(
        List<PlayerInput> source,
        List<ValidationError> errors
    ) {
        var players = source == null ? List.<PlayerInput>of() : source;
        if (players.isEmpty() || players.size() > MAX_PLAYERS) {
            errors.add(new ValidationError("players", "player count must be 1~" + MAX_PLAYERS));
        }

        var normalized = new ArrayList<PlayerConfig>();
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

            normalized.add(new PlayerConfig(
                soopId,
                normalizeText(player.displayName(), soopId),
                blankToNull(player.profileImageUrl()),
                player.balloonTrigger(),
                null
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

    private static RulesConfig normalizeRules(
        RulesInput input,
        List<ValidationError> errors
    ) {
        RulesInput rules = input == null
            ? new RulesInput("destinationOnly", true, true)
            : input;

        String landingMode = normalizeText(
            rules.landingInstructionMode(),
            "destinationOnly"
        );

        if (!"destinationOnly".equalsIgnoreCase(landingMode)) {
            errors.add(new ValidationError(
                "rules.landingInstructionMode",
                "only destinationOnly is currently supported"
            ));
            landingMode = "destinationOnly";
        }

        return new RulesConfig(
            "destinationOnly",
            rules.resolveLandingBeforeBonusThrow() == null
                || rules.resolveLandingBeforeBonusThrow(),
            rules.skipNextThrowConsumesBonus() == null
                || rules.skipNextThrowConsumesBonus()
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
            boolean randomCell = Boolean.TRUE.equals(instruction.rerollOnVacate());

            if (randomCell && !"count".equals(mode)) {
                errors.add(new ValidationError(
                    prefix + ".allocation.mode",
                    "random cells must use count allocation"
                ));
            }
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

            validateInstructionAction(instruction, prefix, errors);

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

        Boolean allowSame = input == null
            ? null
            : input.allowSameInstruction();

        var entries = new ArrayList<RandomPoolEntry>();

        if ("inheritRatioInstructions".equalsIgnoreCase(mode)) {
            for (var instruction : instructions) {
                if ("randomCell".equals(instructionActionType(instruction))) continue;
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
                var definition = byId.get(entry.instructionId());
                if ("randomCell".equals(instructionActionType(definition))) {
                    errors.add(new ValidationError(
                        prefix + ".instructionId",
                        "random-cell placeholder cannot be a random pool candidate"
                    ));
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

    private static void validateInstructionAction(
        InstructionInput instruction,
        String prefix,
        List<ValidationError> errors
    ) {
        JsonElement actionElement = instruction.action();
        if (
            actionElement == null
            || actionElement.isJsonNull()
            || !actionElement.isJsonObject()
        ) {
            return;
        }

        JsonObject action = actionElement.getAsJsonObject();
        String type = jsonText(action, "type");

        if ("multiplyNextThrow".equals(type)) {
            int multiplier = jsonInt(action, "multiplier", 0);
            if (multiplier < 2 || multiplier > 100) {
                errors.add(new ValidationError(
                    prefix + ".action.multiplier",
                    "next throw multiplier must be 2~100"
                ));
            }
        } else if ("randomCell".equals(type)) {
            if (!Boolean.TRUE.equals(instruction.rerollOnVacate())) {
                errors.add(new ValidationError(
                    prefix + ".rerollOnVacate",
                    "randomCell action requires rerollOnVacate=true"
                ));
            }
            if (!"count".equalsIgnoreCase(instruction.allocation().mode())) {
                errors.add(new ValidationError(
                    prefix + ".allocation.mode",
                    "randomCell action must use count allocation"
                ));
            }
        } else if ("skipThrow".equals(type) || "ignoreNextLanding".equals(type)) {
            if (jsonInt(action, "count", 1) < 1) {
                errors.add(new ValidationError(
                    prefix + ".action.count",
                    "action count must be >= 1"
                ));
            }
        }
    }

    private static String instructionActionType(InstructionInput instruction) {
        if (
            instruction == null
            || instruction.action() == null
            || !instruction.action().isJsonObject()
        ) {
            return "";
        }
        return jsonText(instruction.action().getAsJsonObject(), "type");
    }

    private static String jsonText(JsonObject object, String key) {
        try {
            JsonElement value = object.get(key);
            return value != null && !value.isJsonNull() ? value.getAsString() : "";
        } catch (RuntimeException ignored) {
            return "";
        }
    }

    private static int jsonInt(JsonObject object, String key, int fallback) {
        try {
            JsonElement value = object.get(key);
            return value != null && !value.isJsonNull() ? value.getAsInt() : fallback;
        } catch (RuntimeException ignored) {
            return fallback;
        }
    }

    private static int normalizeRetentionMinutes(
        Integer requested,
        List<ValidationError> errors
    ) {
        int value = requested == null ? DEFAULT_RETENTION_MINUTES : requested;
        if (value < 1 || value > MAX_RETENTION_MINUTES) {
            errors.add(new ValidationError(
                "retentionMinutes",
                "retentionMinutes must be 1~" + MAX_RETENTION_MINUTES
            ));
            return Math.max(1, Math.min(MAX_RETENTION_MINUTES, value));
        }
        return value;
    }

    private static OffsetDateTime parseStoredDateTime(String value) {
        if (value == null || value.isBlank()) return null;
        try {
            return OffsetDateTime.parse(value);
        } catch (java.time.format.DateTimeParseException ignored) {
            try {
                return java.time.LocalDateTime.parse(
                    value,
                    java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
                ).atOffset(java.time.ZoneOffset.UTC);
            } catch (java.time.format.DateTimeParseException ignoredAgain) {
                return null;
            }
        }
    }

    private static int normalizePauseGraceSeconds(
        Integer requested,
        List<ValidationError> errors
    ) {
        int value = requested == null ? DEFAULT_PAUSE_GRACE_SECONDS : requested;
        if (value < 0 || value > MAX_PAUSE_GRACE_SECONDS) {
            errors.add(new ValidationError(
                "pauseGraceSeconds",
                "pauseGraceSeconds must be 0~" + MAX_PAUSE_GRACE_SECONDS
            ));
            return Math.max(0, Math.min(MAX_PAUSE_GRACE_SECONDS, value));
        }
        return value;
    }

    private static String normalizePauseDonationMode(
        String requested,
        List<ValidationError> errors
    ) {
        String mode = normalizeText(requested, "QUEUE").toUpperCase();
        if (!Set.of("QUEUE", "IGNORE").contains(mode)) {
            errors.add(new ValidationError(
                "pauseDonationMode",
                "pauseDonationMode must be QUEUE or IGNORE"
            ));
            return "QUEUE";
        }
        return mode;
    }

    private BoardPreview generateSafePreview(NormalizedRoomConfig config) {
        FixedInstructionCycleValidator.Cycle lastCycle = null;

        for (int attempt = 0; attempt < MAX_SAFE_LAYOUT_ATTEMPTS; attempt++) {
            long seed = nextSeed();
            var preview = layoutGenerator.generate(config, seed);
            var cycle = cycleValidator.findCycle(preview);
            if (cycle.isEmpty()) return preview;
            lastCycle = cycle.get();
        }

        String detail = lastCycle == null ? "" : " last cycle: " + lastCycle.describe();
        throw new IllegalStateException(
            "unable to generate a fixed-cycle-free board after "
                + MAX_SAFE_LAYOUT_ATTEMPTS + " attempts." + detail
        );
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
