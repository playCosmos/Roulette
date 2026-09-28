package io.github.playcosmos.roulettebridge.boardserver;

import io.github.playcosmos.roulettebridge.db.DatabaseAccess;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.SQLException;
import java.time.Instant;
import java.util.Base64;
import java.util.Locale;
import java.util.function.Supplier;

public final class AdminAuthStore {
    private static final Base64.Encoder HASH_ENCODER =
        Base64.getUrlEncoder().withoutPadding();

    private final DatabaseAccess database;

    public AdminAuthStore(DatabaseAccess database) {
        this.database = database;
    }

    public record ApprovalRequest(
        String code,
        String status,
        Instant expiresAt
    ) {}

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
                deleteAllSessionsAndApprovals(connection);
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

    public boolean createApprovalRequest(
        String requestId,
        String approvalCode,
        Instant expiresAt
    ) throws SQLException {
        Instant now = Instant.now();
        cleanupExpiredApprovalRequests(now);
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 INSERT OR IGNORE INTO board_admin_approval_request(
                   request_hash, approval_code, status,
                   expires_at, created_at, approved_at
                 ) VALUES (?, ?, 'PENDING', ?, ?, NULL)
                 """)) {
            statement.setString(1, hash(requestId));
            statement.setString(
                2,
                normalizeApprovalCode(approvalCode)
            );
            statement.setString(3, expiresAt.toString());
            statement.setString(4, now.toString());
            return statement.executeUpdate() == 1;
        }
    }

    public ApprovalRequest findApprovalRequest(
        String requestId,
        Instant now
    ) throws SQLException {
        cleanupExpiredApprovalRequests(now);
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT approval_code, status, expires_at
                 FROM board_admin_approval_request
                 WHERE request_hash = ?
                 """)) {
            statement.setString(1, hash(requestId));
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) return null;
                return new ApprovalRequest(
                    rows.getString(1),
                    rows.getString(2),
                    Instant.parse(rows.getString(3))
                );
            }
        }
    }

    public boolean approveApprovalRequest(
        String approvalCode,
        Instant now
    ) throws SQLException {
        cleanupExpiredApprovalRequests(now);
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 UPDATE board_admin_approval_request
                 SET status = 'APPROVED', approved_at = ?
                 WHERE approval_code = ?
                   AND status = 'PENDING'
                   AND expires_at > ?
                 """)) {
            statement.setString(1, now.toString());
            statement.setString(
                2,
                normalizeApprovalCode(approvalCode)
            );
            statement.setString(3, now.toString());
            return statement.executeUpdate() == 1;
        }
    }

    public boolean consumeApprovedApprovalRequest(
        String requestId,
        Instant now
    ) throws SQLException {
        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                String requestHash = hash(requestId);
                boolean approved = false;
                try (var select = connection.prepareStatement("""
                    SELECT status, expires_at
                    FROM board_admin_approval_request
                    WHERE request_hash = ?
                    """)) {
                    select.setString(1, requestHash);
                    try (var rows = select.executeQuery()) {
                        if (rows.next()) {
                            Instant expiresAt = Instant.parse(
                                rows.getString(2)
                            );
                            approved =
                                "APPROVED".equals(rows.getString(1))
                                && expiresAt.isAfter(now);
                        }
                    }
                }

                if (!approved) {
                    connection.commit();
                    return false;
                }

                try (var delete = connection.prepareStatement("""
                    DELETE FROM board_admin_approval_request
                    WHERE request_hash = ?
                    """)) {
                    delete.setString(1, requestHash);
                    if (delete.executeUpdate() != 1) {
                        connection.rollback();
                        return false;
                    }
                }

                connection.commit();
                return true;
            } catch (SQLException error) {
                connection.rollback();
                throw error;
            } finally {
                connection.setAutoCommit(true);
            }
        }
    }

    public int countPendingApprovalRequests(Instant now)
        throws SQLException {
        cleanupExpiredApprovalRequests(now);
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT COUNT(*)
                 FROM board_admin_approval_request
                 WHERE status = 'PENDING'
                 """);
             var rows = statement.executeQuery()) {
            return rows.next() ? rows.getInt(1) : 0;
        }
    }

    public void cleanupExpiredApprovalRequests(Instant now)
        throws SQLException {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 DELETE FROM board_admin_approval_request
                 WHERE expires_at <= ?
                 """)) {
            statement.setString(1, now.toString());
            statement.executeUpdate();
        }
    }

    public int revokeAllSessions() throws SQLException {
        Instant now = Instant.now();
        cleanupExpired(now);
        cleanupExpiredApprovalRequests(now);
        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                int active;
                try (var count = connection.prepareStatement(
                         "SELECT COUNT(*) FROM board_admin_session"
                     );
                     var rows = count.executeQuery()) {
                    active = rows.next() ? rows.getInt(1) : 0;
                }
                deleteAllSessionsAndApprovals(connection);
                connection.commit();
                return active;
            } catch (SQLException error) {
                connection.rollback();
                throw error;
            } finally {
                connection.setAutoCommit(true);
            }
        }
    }

    private static void deleteAllSessionsAndApprovals(
        java.sql.Connection connection
    ) throws SQLException {
        try (var deleteSessions = connection.prepareStatement(
            "DELETE FROM board_admin_session"
        )) {
            deleteSessions.executeUpdate();
        }
        try (var deleteApprovals = connection.prepareStatement(
            "DELETE FROM board_admin_approval_request"
        )) {
            deleteApprovals.executeUpdate();
        }
    }

    private static String normalizeApprovalCode(String code) {
        return code == null
            ? ""
            : code.trim().toUpperCase(Locale.ROOT);
    }

    private static String hash(String value) {
        try {
            byte[] digest = MessageDigest
                .getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8));
            return HASH_ENCODER.encodeToString(digest);
        } catch (Exception error) {
            throw new IllegalStateException(
                "SHA-256 unavailable",
                error
            );
        }
    }
}
