package io.github.playcosmos.roulettebridge.config;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

public final class ConfigLoader {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    private ConfigLoader() {}

    public static BridgeConfig loadOrCreate(Path path) throws IOException {
        if (Files.notExists(path)) {
            var defaults = loadDefaults();
            if (path.getParent() != null) Files.createDirectories(path.getParent());
            Files.writeString(path, GSON.toJson(defaults), StandardCharsets.UTF_8);
            System.out.println("[config] created " + path.toAbsolutePath());
            return defaults.normalized();
        }

        try (var reader = Files.newBufferedReader(path, StandardCharsets.UTF_8)) {
            var config = GSON.fromJson(reader, BridgeConfig.class);
            if (config == null) throw new IOException("config.json is empty");
            return config.normalized();
        }
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
