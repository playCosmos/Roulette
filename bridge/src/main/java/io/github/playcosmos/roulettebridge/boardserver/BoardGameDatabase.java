package io.github.playcosmos.roulettebridge.boardserver;

import io.github.playcosmos.roulettebridge.db.DatabaseAccess;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;

public final class BoardGameDatabase implements DatabaseAccess {
    private static final int CURRENT_SCHEMA_VERSION = 7;
    private static final String[] MIGRATIONS = {
        "/db/migration/V4__board_rooms.sql",
        "/db/migration/V5__board_room_live_status.sql",
        "/db/migration/V6__board_game_runtime.sql",
        "/db/migration/V7__single_active_board_room.sql",
        "/db/migration/V8__room_lifecycle_pause_and_effects.sql",
        "/db/migration/V9__pause_broadcast_grace.sql",
        "/db/migration/V10__multi_active_room_policy.sql"
    };

    private final Path databasePath;
    private final String jdbcUrl;

    public BoardGameDatabase(Path databasePath) throws IOException {
        this.databasePath = databasePath.toAbsolutePath().normalize();
        if (this.databasePath.getParent() != null) Files.createDirectories(this.databasePath.getParent());
        this.jdbcUrl = "jdbc:sqlite:" + this.databasePath;
    }

    @Override
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

    @Override
    public Connection open() throws SQLException {
        var connection = DriverManager.getConnection(jdbcUrl);
        try (var statement = connection.createStatement()) {
            statement.execute("PRAGMA foreign_keys=ON");
            statement.execute("PRAGMA busy_timeout=5000");
        }
        return connection;
    }

    private void migrate(Connection connection) throws SQLException, IOException {
        int version;
        try (var statement = connection.createStatement();
             var rows = statement.executeQuery("PRAGMA user_version")) {
            version = rows.next() ? rows.getInt(1) : 0;
        }

        if (version > CURRENT_SCHEMA_VERSION) {
            throw new SQLException("board database schema is newer than this application: " + version);
        }

        while (version < CURRENT_SCHEMA_VERSION) {
            applyMigration(connection, MIGRATIONS[version]);
            version += 1;
            try (var statement = connection.createStatement()) {
                statement.execute("PRAGMA user_version=" + version);
            }
        }
    }

    private static void applyMigration(Connection connection, String resource) throws IOException, SQLException {
        try (var stream = BoardGameDatabase.class.getResourceAsStream(resource)) {
            if (stream == null) throw new IOException("missing board migration resource: " + resource);
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
                throw new SQLException("board migration failed", error);
            } finally {
                connection.setAutoCommit(true);
            }
        }
    }
}
