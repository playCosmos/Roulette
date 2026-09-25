package io.github.playcosmos.roulettebridge.boardserver;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.AtomicMoveNotSupportedException;

public final class BoardServerConfigLoader {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    private BoardServerConfigLoader() {}

    public static BoardServerConfig loadOrCreate(Path path) throws IOException {
        if (Files.notExists(path)) {
            var defaults = BoardServerConfig.defaults().normalized();
            save(path, defaults);
            return defaults;
        }
        try (var reader = Files.newBufferedReader(path, StandardCharsets.UTF_8)) {
            var config = GSON.fromJson(reader, BoardServerConfig.class);
            if (config == null) throw new IOException("config.json is empty");
            return config.normalized();
        }
    }

    public static BoardServerConfig save(Path path, BoardServerConfig config) throws IOException {
        var normalized = config.normalized();
        Path absolute = path.toAbsolutePath().normalize();
        if (absolute.getParent() != null) Files.createDirectories(absolute.getParent());
        Path temp = absolute.resolveSibling(absolute.getFileName() + ".tmp");
        Files.writeString(temp, GSON.toJson(normalized) + System.lineSeparator(), StandardCharsets.UTF_8);
        try {
            Files.move(temp, absolute, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException ignored) {
            Files.move(temp, absolute, StandardCopyOption.REPLACE_EXISTING);
        }
        return normalized;
    }
}
