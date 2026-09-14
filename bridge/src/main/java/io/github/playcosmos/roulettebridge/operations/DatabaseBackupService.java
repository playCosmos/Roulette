package io.github.playcosmos.roulettebridge.operations;

import io.github.playcosmos.roulettebridge.db.BridgeDatabase;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Objects;

public final class DatabaseBackupService {
    private static final DateTimeFormatter FILE_TIME = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss-SSS");

    private final BridgeDatabase database;
    private final Path backupDirectory;

    public DatabaseBackupService(BridgeDatabase database, Path backupDirectory) throws IOException {
        this.database = Objects.requireNonNull(database, "database");
        this.backupDirectory = backupDirectory.toAbsolutePath().normalize();
        Files.createDirectories(this.backupDirectory);
    }

    public Path backupDirectory() {
        return backupDirectory;
    }

    public synchronized Path createBackup() throws SQLException, IOException {
        Files.createDirectories(backupDirectory);
        Path target = backupDirectory.resolve(
            "roulette-" + LocalDateTime.now().format(FILE_TIME) + ".db"
        ).normalize();
        if (!target.startsWith(backupDirectory)) throw new IOException("invalid backup path");
        Files.deleteIfExists(target);

        String escaped = target.toString().replace("'", "''");
        try (var connection = database.open();
             var statement = connection.createStatement()) {
            statement.execute("VACUUM INTO '" + escaped + "'");
        }

        if (!Files.isRegularFile(target) || Files.size(target) == 0) {
            throw new IOException("SQLite backup was not created: " + target);
        }
        return target;
    }
}
