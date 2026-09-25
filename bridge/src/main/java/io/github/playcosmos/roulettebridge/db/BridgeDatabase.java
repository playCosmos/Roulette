package io.github.playcosmos.roulettebridge.db;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;

public final class BridgeDatabase implements DatabaseAccess {
    private static final int CURRENT_SCHEMA_VERSION = 9;
    private final Path databasePath;
    private final String jdbcUrl;

    public BridgeDatabase(Path databasePath) throws IOException {
        this.databasePath = databasePath.toAbsolutePath().normalize();
        if (this.databasePath.getParent() != null) Files.createDirectories(this.databasePath.getParent());
        this.jdbcUrl = "jdbc:sqlite:" + this.databasePath;
    }

    public Path path() {
        return databasePath;
    }

    public void initialize() throws SQLException, IOException {
        try (var connection = open()) {
            try (var statement = connection.createStatement()) {
                statement.execute("PRAGMA journal_mode=WAL");
                statement.execute("PRAGMA foreign_keys=ON");
                statement.execute("PRAGMA busy_timeout=5000");
            }
            migrate(connection);
        }
    }

    public Connection open() throws SQLException {
        var connection = DriverManager.getConnection(jdbcUrl);
        try (var statement = connection.createStatement()) {
            statement.execute("PRAGMA foreign_keys=ON");
            statement.execute("PRAGMA busy_timeout=5000");
        }
        return connection;
    }

    public List<PendingTicket> findRecoverableTickets() throws SQLException {
        var result = new ArrayList<PendingTicket>();
        var sql = """
            SELECT ticket_id, donor_id, nickname_at_issue, ticket_sequence,
                   numbers_json, status, image_path, created_at
            FROM ticket
            WHERE status NOT IN ('ISSUED', 'FAILED')
            ORDER BY created_at ASC
            """;

        try (var connection = open();
             var statement = connection.prepareStatement(sql);
             var rows = statement.executeQuery()) {
            while (rows.next()) {
                result.add(new PendingTicket(
                    rows.getString("ticket_id"),
                    rows.getString("donor_id"),
                    rows.getString("nickname_at_issue"),
                    rows.getObject("ticket_sequence") == null ? null : rows.getInt("ticket_sequence"),
                    rows.getString("numbers_json"),
                    rows.getString("status"),
                    rows.getString("image_path"),
                    rows.getString("created_at")
                ));
            }
        }
        return result;
    }

    public int countRecoverableTickets() throws SQLException {
        try (var connection = open();
             var statement = connection.prepareStatement(
                 "SELECT COUNT(*) FROM ticket WHERE status NOT IN ('ISSUED', 'FAILED')"
             );
             var rows = statement.executeQuery()) {
            return rows.next() ? rows.getInt(1) : 0;
        }
    }

    private void migrate(Connection connection) throws SQLException, IOException {
        int version;
        try (var statement = connection.createStatement();
             var rows = statement.executeQuery("PRAGMA user_version")) {
            version = rows.next() ? rows.getInt(1) : 0;
        }

        if (version > CURRENT_SCHEMA_VERSION) {
            throw new SQLException("database schema is newer than this application: " + version);
        }

        if (version < 1) {
            applyMigration(connection, "/db/migration/V1__initial.sql");
            setVersion(connection, 1);
            version = 1;
        }

        if (version < 2) {
            applyMigration(connection, "/db/migration/V2__phase_d_issuance.sql");
            setVersion(connection, 2);
            version = 2;
        }

        if (version < 3) {
            applyMigration(connection, "/db/migration/V3__operations.sql");
            setVersion(connection, 3);
            version = 3;
        }

        if (version < 4) {
            applyMigration(connection, "/db/migration/V4__board_rooms.sql");
            setVersion(connection, 4);
            version = 4;
        }

        if (version < 5) {
            applyMigration(connection, "/db/migration/V5__board_room_live_status.sql");
            setVersion(connection, 5);
            version = 5;
        }

        if (version < 6) {
            applyMigration(connection, "/db/migration/V6__board_game_runtime.sql");
            setVersion(connection, 6);
            version = 6;
        }

        if (version < 7) {
            applyMigration(connection, "/db/migration/V7__single_active_board_room.sql");
            setVersion(connection, 7);
            version = 7;
        }

        if (version < 8) {
            applyMigration(connection, "/db/migration/V8__room_lifecycle_pause_and_effects.sql");
            setVersion(connection, 8);
            version = 8;
        }

        if (version < 9) {
            applyMigration(connection, "/db/migration/V9__pause_broadcast_grace.sql");
            setVersion(connection, 9);
            version = 9;
        }

        if (version != CURRENT_SCHEMA_VERSION) {
            throw new SQLException("unsupported database schema version: " + version);
        }
    }

    private static void setVersion(Connection connection, int version) throws SQLException {
        try (var statement = connection.createStatement()) {
            statement.execute("PRAGMA user_version=" + version);
        }
    }

    private static void applyMigration(Connection connection, String resource) throws IOException, SQLException {
        var stream = BridgeDatabase.class.getResourceAsStream(resource);
        if (stream == null) throw new IOException("missing migration resource: " + resource);
        var sql = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        connection.setAutoCommit(false);
        try {
            for (var statementSql : sql.split(";")) {
                var trimmed = statementSql.trim();
                if (trimmed.isEmpty()) continue;
                try (var statement = connection.createStatement()) {
                    statement.execute(trimmed);
                }
            }
            connection.commit();
        } catch (Exception error) {
            connection.rollback();
            if (error instanceof SQLException sqlError) throw sqlError;
            if (error instanceof IOException ioError) throw ioError;
            throw new SQLException("migration failed", error);
        } finally {
            connection.setAutoCommit(true);
        }
    }

    public record PendingTicket(
        String ticketId,
        String donorId,
        String nickname,
        Integer ticketSequence,
        String numbersJson,
        String status,
        String imagePath,
        String createdAt
    ) {}
}
