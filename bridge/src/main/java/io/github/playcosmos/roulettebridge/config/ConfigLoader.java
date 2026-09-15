package io.github.playcosmos.roulettebridge.config;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

public final class ConfigLoader {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    private ConfigLoader() {}

    public static BridgeConfig loadOrCreate(Path path) throws IOException {
        if (Files.notExists(path)) {
            var defaults = loadDefaults().normalized();
            save(path, defaults);
            System.out.println("[config] created " + path.toAbsolutePath());
            return defaults;
        }
        return load(path);
    }

    public static BridgeConfig load(Path path) throws IOException {
        try (var reader = Files.newBufferedReader(path, StandardCharsets.UTF_8)) {
            var config = GSON.fromJson(reader, BridgeConfig.class);
            if (config == null) throw new IOException("config.json is empty");
            return config.normalized();
        }
    }

    public static BridgeConfig save(Path path, BridgeConfig config) throws IOException {
        if (config == null) throw new IllegalArgumentException("config is required");
        var normalized = config.normalized();
        Path absolute = path.toAbsolutePath().normalize();
        Path parent = absolute.getParent();
        if (parent != null) Files.createDirectories(parent);
        Path temp = absolute.resolveSibling(absolute.getFileName() + ".tmp");
        Files.writeString(temp, GSON.toJson(normalized) + System.lineSeparator(), StandardCharsets.UTF_8);
        try {
            Files.move(temp, absolute, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException ignored) {
            Files.move(temp, absolute, StandardCopyOption.REPLACE_EXISTING);
        }
        return normalized;
    }

    private static BridgeConfig loadDefaults() throws IOException {
        try (var stream = ConfigLoader.class.getResourceAsStream("/default-config.json")) {
            if (stream == null) return BridgeConfig.defaults();
            try (var reader = new InputStreamReader(stream, StandardCharsets.UTF_8)) {
                var config = GSON.fromJson(reader, BridgeConfig.class);
                return config == null ? BridgeConfig.defaults() : config;
            }
        }
    }
}
