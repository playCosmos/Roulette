package io.github.playcosmos.roulettebridge.boardserver;

import io.github.playcosmos.roulettebridge.db.DatabaseAccess;
import java.sql.SQLException;
import java.time.OffsetDateTime;

public final class ServerPolicyService {
    public static final int MIN_ACTIVE_ROOM_LIMIT = 1;
    public static final int MAX_ACTIVE_ROOM_LIMIT = 32;
    private static final String ACTIVE_ROOM_LIMIT_KEY =
        "active_room_limit";

    private final DatabaseAccess database;

    public ServerPolicyService(DatabaseAccess database) {
        this.database = database;
    }

    public int activeRoomLimit() {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT policy_value
                 FROM board_server_policy
                 WHERE policy_key = ?
                 """)) {
            statement.setString(1, ACTIVE_ROOM_LIMIT_KEY);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) return 1;
                int parsed = Integer.parseInt(rows.getString(1));
                return normalizeActiveRoomLimit(parsed);
            }
        } catch (Exception error) {
            return 1;
        }
    }

    public int setActiveRoomLimit(int value) throws SQLException {
        int normalized = requireActiveRoomLimit(value);
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 INSERT INTO board_server_policy(
                   policy_key, policy_value, updated_at
                 ) VALUES (?, ?, ?)
                 ON CONFLICT(policy_key) DO UPDATE SET
                   policy_value = excluded.policy_value,
                   updated_at = excluded.updated_at
                 """)) {
            statement.setString(1, ACTIVE_ROOM_LIMIT_KEY);
            statement.setString(2, Integer.toString(normalized));
            statement.setString(3, OffsetDateTime.now().toString());
            statement.executeUpdate();
        }
        return normalized;
    }

    private static int requireActiveRoomLimit(int value) {
        if (
            value < MIN_ACTIVE_ROOM_LIMIT
            || value > MAX_ACTIVE_ROOM_LIMIT
        ) {
            throw new IllegalArgumentException(
                "activeRoomLimit must be "
                    + MIN_ACTIVE_ROOM_LIMIT
                    + "~"
                    + MAX_ACTIVE_ROOM_LIMIT
            );
        }
        return value;
    }

    private static int normalizeActiveRoomLimit(int value) {
        if (value < MIN_ACTIVE_ROOM_LIMIT) {
            return MIN_ACTIVE_ROOM_LIMIT;
        }
        if (value > MAX_ACTIVE_ROOM_LIMIT) {
            return MAX_ACTIVE_ROOM_LIMIT;
        }
        return value;
    }
}
