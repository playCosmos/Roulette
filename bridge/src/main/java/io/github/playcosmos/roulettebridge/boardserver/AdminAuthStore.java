package io.github.playcosmos.roulettebridge.boardserver;

import io.github.playcosmos.roulettebridge.db.DatabaseAccess;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.SQLException;
import java.time.Instant;
import java.util.Base64;
import java.util.function.Supplier;

public final class AdminAuthStore {
    private static final Base64.Encoder HASH_ENCODER =
        Base64.getUrlEncoder().withoutPadding();

    private final DatabaseAccess database;

    public AdminAuthStore(DatabaseAccess database) {
        this.database = database;
    }

    public String bootstrapTokenOrCreate(
        Supplier<String> tokenSupplier
    ) throws SQLException {
        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                try (var select = connection.prepareStatement("""
                    SELECT bootstrap_token
                    FROM board_admin_auth_state
                    WHERE singleton_id = 1
                    """);
                     var rows = select.executeQuery()) {
                    if (rows.next()) {
                        String existing = rows.getString(1);
                        connection.commit();
                        return existing;
                    }
                }

                String created = tokenSupplier.get();
                String now = Instant.now().toString();
                try (var insert = connection.prepareStatement("""
                    INSERT INTO board_admin_auth_state(
                      singleton_id, bootstrap_token, updated_at
                    ) VALUES (1, ?, ?)
                    """)) {
                    insert.setString(1, created);
                    insert.setString(2, now);
                    insert.executeUpdate();
                }
                connection.commit();
                return created;
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sql) throw sql;
                throw new SQLException(
                    "failed to initialize admin auth",
                    error
                );
            } finally {
                connection.setAutoCommit(true);
            }
        }
    }

    public void rotateBootstrapToken(String token)
        throws SQLException {
        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                try (var statement = connection.prepareStatement("""
                    INSERT INTO board_admin_auth_state(
                      singleton_id, bootstrap_token, updated_at
                    ) VALUES (1, ?, ?)
                    ON CONFLICT(singleton_id) DO UPDATE SET
                      bootstrap_token = excluded.bootstrap_token,
                      updated_at = excluded.updated_at
                    """)) {
                    statement.setString(1, token);
                    statement.setString(
                        2,
                        Instant.now().toString()
                    );
                    statement.executeUpdate();
                }
                try (var statement = connection.prepareStatement(
                    "DELETE FROM board_admin_session"
                )) {
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

    public void createSession(
        String sessionId,
        Instant expiresAt
    ) throws SQLException {
        String now = Instant.now().toString();
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 INSERT INTO board_admin_session(
                   session_hash, expires_at, created_at, updated_at
                 ) VALUES (?, ?, ?, ?)
                 ON CONFLICT(session_hash) DO UPDATE SET
                   expires_at = excluded.expires_at,
                   updated_at = excluded.updated_at
                 """)) {
            statement.setString(1, hash(sessionId));
            statement.setString(2, expiresAt.toString());
            statement.setString(3, now);
            statement.setString(4, now);
            statement.executeUpdate();
        }
    }

    public Instant sessionExpiresAt(String sessionId)
        throws SQLException {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT expires_at
                 FROM board_admin_session
                 WHERE session_hash = ?
                 """)) {
            statement.setString(1, hash(sessionId));
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) return null;
                return Instant.parse(rows.getString(1));
            }
        }
    }

    public void refreshSession(
        String sessionId,
        Instant expiresAt
    ) throws SQLException {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 UPDATE board_admin_session
                 SET expires_at = ?, updated_at = ?
                 WHERE session_hash = ?
                 """)) {
            statement.setString(1, expiresAt.toString());
            statement.setString(2, Instant.now().toString());
            statement.setString(3, hash(sessionId));
            statement.executeUpdate();
        }
    }

    public void deleteSession(String sessionId)
        throws SQLException {
        try (var connection = database.open();
             var statement = connection.prepareStatement(
                 "DELETE FROM board_admin_session WHERE session_hash = ?"
             )) {
            statement.setString(1, hash(sessionId));
            statement.executeUpdate();
        }
    }

    public void cleanupExpired(Instant now)
        throws SQLException {
        try (var connection = database.open();
             var statement = connection.prepareStatement(
                 "DELETE FROM board_admin_session WHERE expires_at <= ?"
             )) {
            statement.setString(1, now.toString());
            statement.executeUpdate();
        }
    }

    public int countActiveSessions(Instant now)
        throws SQLException {
        cleanupExpired(now);
        try (var connection = database.open();
             var statement = connection.prepareStatement(
                 "SELECT COUNT(*) FROM board_admin_session"
             );
             var rows = statement.executeQuery()) {
            return rows.next() ? rows.getInt(1) : 0;
        }
    }

    public int revokeAllSessions() throws SQLException {
        cleanupExpired(Instant.now());
        try (var connection = database.open()) {
            int active;
            try (var count = connection.prepareStatement(
                     "SELECT COUNT(*) FROM board_admin_session"
                 );
                 var rows = count.executeQuery()) {
                active = rows.next() ? rows.getInt(1) : 0;
            }
            try (var delete = connection.prepareStatement(
                "DELETE FROM board_admin_session"
            )) {
                delete.executeUpdate();
            }
            return active;
        }
    }

    private static String hash(String sessionId) {
        try {
            byte[] digest = MessageDigest
                .getInstance("SHA-256")
                .digest(sessionId.getBytes(StandardCharsets.UTF_8));
            return HASH_ENCODER.encodeToString(digest);
        } catch (Exception error) {
            throw new IllegalStateException(
                "SHA-256 unavailable",
                error
            );
        }
    }
}
