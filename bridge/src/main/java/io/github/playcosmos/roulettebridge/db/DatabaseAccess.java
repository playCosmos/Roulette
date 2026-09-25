package io.github.playcosmos.roulettebridge.db;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;

public interface DatabaseAccess {
    Path path();
    Connection open() throws SQLException;
}
