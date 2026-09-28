package io.github.playcosmos.roulettebridge.boardserver;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

public final class BoardServerConfigPersistenceProbe {
    private BoardServerConfigPersistenceProbe() {}

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("ramyani-board-config-probe-");
        try {
            Path configPath = root.resolve("config.json");

            if (Files.exists(configPath)) {
                throw new IllegalStateException("probe config unexpectedly exists");
            }

            var created = BoardServerConfigLoader.loadOrCreate(configPath);
            if (!Files.isRegularFile(configPath)) {
                throw new IllegalStateException("missing config was not created");
            }
            if (!"127.0.0.1".equals(created.server().host())) {
                throw new IllegalStateException("created config did not use defaults");
            }

            String existing = """
                {
                  "streamerId": "existing-streamer",
                  "server": {
                    "host": "127.0.0.1",
                    "port": 17830,
                    "websocketPort": 17831,
                    "openBrowserOnStart": false,
                    "clientHost": "0.0.0.0",
                    "clientPort": 17832,
                    "publicBaseUrl": "https://existing.example",
                    "publicWebSocketUrl": "wss://existing.example/ws"
                  },
                  "storage": {
                    "databasePath": "./data/existing-board.db",
                    "webRoot": "./web",
                    "logDirectory": "./logs"
                  },
                  "soop": {
                    "enabled": true,
                    "offlinePollSeconds": 45
                  }
                }
                """;
            Files.writeString(
                configPath,
                existing,
                StandardCharsets.UTF_8
            );

            String before = Files.readString(
                configPath,
                StandardCharsets.UTF_8
            );
            var loaded = BoardServerConfigLoader.loadOrCreate(configPath);
            String after = Files.readString(
                configPath,
                StandardCharsets.UTF_8
            );

            if (!before.equals(after)) {
                throw new IllegalStateException(
                    "existing config.json was modified during load"
                );
            }
            if (!"existing-streamer".equals(loaded.streamerId())) {
                throw new IllegalStateException("existing streamerId was not loaded");
            }
            if (!"https://existing.example".equals(
                loaded.server().publicBaseUrl()
            )) {
                throw new IllegalStateException("existing publicBaseUrl was not loaded");
            }
            if (!"wss://existing.example/ws".equals(
                loaded.server().publicWebSocketUrl()
            )) {
                throw new IllegalStateException(
                    "existing publicWebSocketUrl was not loaded"
                );
            }
            if (!"./data/existing-board.db".equals(
                loaded.storage().databasePath()
            )) {
                throw new IllegalStateException(
                    "existing databasePath was not loaded"
                );
            }

            System.out.println(
                "Board server config persistence probe passed."
            );
        } finally {
            try (var paths = Files.walk(root)) {
                paths.sorted((left, right) -> right.compareTo(left))
                    .forEach(path -> {
                        try {
                            Files.deleteIfExists(path);
                        } catch (Exception ignored) {
                        }
                    });
            }
        }
    }
}
