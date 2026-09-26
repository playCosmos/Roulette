package io.github.playcosmos.roulettebridge.boardserver;

import io.github.playcosmos.roulettebridge.room.BoardGameRuntimeEngine;
import io.github.playcosmos.roulettebridge.room.RoomService;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

public final class ClientBoundaryProbe {
    private ClientBoundaryProbe() {}

    public static void main(String[] args) {
        System.exit(run());
    }

    public static int run() {
        Path root = null;
        GameClientHttpServer server = null;
        try {
            root = Files.createTempDirectory("games-client-boundary-");
            Path webRoot = root.resolve("web");
            Path boardRoot = webRoot.resolve("games/board");
            Files.createDirectories(boardRoot);
            Files.writeString(
                boardRoot.resolve("index.html"),
                "<!doctype html><title>board client</title>",
                StandardCharsets.UTF_8
            );
            Files.writeString(
                webRoot.resolve("board-admin.html"),
                "<!doctype html><title>admin</title>",
                StandardCharsets.UTF_8
            );

            int adminPort = freePort();
            int clientPort = freePort();
            int websocketPort = freePort();

            var config = new BoardServerConfig(
                "",
                new BoardServerConfig.Server(
                    "127.0.0.1",
                    adminPort,
                    websocketPort,
                    false,
                    "127.0.0.1",
                    clientPort,
                    "",
                    ""
                ),
                new BoardServerConfig.Storage(
                    "./data/board-game.db",
                    "./web",
                    "./logs"
                ),
                new BoardServerConfig.Soop(false, 30)
            ).normalized();

            var database = new BoardGameDatabase(
                root.resolve("data/board-game.db")
            );
            database.initialize();
            var rooms = new RoomService(database, players -> players);
            var runtime = new BoardGameRuntimeEngine(
                database,
                event -> {}
            );

            server = new GameClientHttpServer(
                config,
                root,
                rooms,
                runtime
            );
            server.start();

            var client = HttpClient.newHttpClient();
            URI base = URI.create(
                "http://127.0.0.1:" + clientPort
            );

            var boardResponse = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/games/board/index.html")
                ).GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                boardResponse.statusCode() == 200,
                "board client asset must be public"
            );

            var adminResponse = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/board-admin.html")
                ).GET().build(),
                HttpResponse.BodyHandlers.discarding()
            );
            require(
                adminResponse.statusCode() == 404,
                "admin page must not be exposed on client server"
            );

            var postResponse = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/board/rooms")
                )
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{}"))
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                postResponse.statusCode() == 405,
                "client server must reject room mutation POST"
            );

            System.out.println("[client-boundary-probe] PASS");
            return 0;
        } catch (Exception error) {
            System.err.println(
                "[client-boundary-probe] FAIL: " + error.getMessage()
            );
            error.printStackTrace(System.err);
            return 1;
        } finally {
            if (server != null) {
                try { server.close(); } catch (Exception ignored) {}
            }
            if (root != null) {
                try (var paths = Files.walk(root)) {
                    paths.sorted((a, b) -> b.compareTo(a)).forEach(path -> {
                        try {
                            Files.deleteIfExists(path);
                        } catch (Exception ignored) {
                        }
                    });
                } catch (Exception ignored) {
                }
            }
        }
    }

    private static int freePort() throws Exception {
        try (var socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new IllegalStateException(message);
        }
    }
}
