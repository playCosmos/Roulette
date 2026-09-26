package io.github.playcosmos.roulettebridge.boardserver;

import io.github.playcosmos.roulettebridge.room.BoardGameRuntimeEngine;
import io.github.playcosmos.roulettebridge.room.RoomHttpHandler;
import io.github.playcosmos.roulettebridge.room.RoomService;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

public final class ServerManagementProbe {
    private ServerManagementProbe() {}

    public static void main(String[] args) {
        System.exit(run());
    }

    public static int run() {
        Path root = null;
        BoardGameHttpServer server = null;
        try {
            root = Files.createTempDirectory(
                "ramyani-server-management-probe-"
            );
            Path webRoot = root.resolve("web");
            Files.createDirectories(webRoot);
            Files.writeString(
                webRoot.resolve("server-management.html"),
                "<!doctype html><title>서버 관리</title><h1>서버 관리</h1>",
                StandardCharsets.UTF_8
            );

            int adminPort = freePort();
            int clientPort = freePort();
            int websocketPort = freePort();

            var config = new BoardServerConfig(
                "streamer-test",
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
            var roomHttp = new RoomHttpHandler(rooms, runtime);

            var activeSessions = new AtomicInteger(3);
            var remoteAdminUrl = new AtomicReference<>(
                "http://example.test:17832/admin/?token=old"
            );
            var reconnects = new AtomicInteger(0);

            server = new BoardGameHttpServer(
                config,
                root,
                database.path(),
                () -> 2,
                () -> Map.of("status", "CONNECTED"),
                roomHttp,
                remoteAdminUrl::get,
                () -> "http://127.0.0.1:" + clientPort
                    + "/admin/?token=local",
                activeSessions::get,
                () -> activeSessions.getAndSet(0),
                () -> {
                    activeSessions.set(0);
                    remoteAdminUrl.set(
                        "http://example.test:17832/admin/?token=new"
                    );
                    return remoteAdminUrl.get();
                },
                reconnects::incrementAndGet
            );
            server.start();

            var client = HttpClient.newHttpClient();
            URI base = URI.create(
                "http://127.0.0.1:" + adminPort
            );

            var page = client.send(
                HttpRequest.newBuilder(base.resolve("/"))
                    .GET()
                    .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                page.statusCode() == 200
                    && page.body().contains("서버 관리"),
                "17830 root must serve server management page"
            );

            var state = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/server-management")
                )
                    .GET()
                    .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                state.statusCode() == 200,
                "server management state must be readable"
            );
            require(
                state.body().contains(
                    "\"activeAdminSessions\":3"
                ),
                "active admin session count missing"
            );
            require(
                state.body().contains("\"version\":\"0.6.1\""),
                "server version missing"
            );
            require(
                state.body().contains(
                    "\"roomAdminUiVersion\":\"0.6.1\""
                ),
                "room admin UI version missing"
            );
            require(
                state.body().contains(
                    "\"websocketClients\":2"
                ),
                "websocket client count missing"
            );

            var revoke = post(
                client,
                base,
                "{\"action\":\"revokeAdminSessions\"}"
            );
            require(
                revoke.statusCode() == 200
                    && revoke.body().contains(
                        "\"revokedSessions\":3"
                    )
                    && activeSessions.get() == 0,
                "admin session revoke action failed"
            );

            activeSessions.set(2);
            var rotate = post(
                client,
                base,
                "{\"action\":\"rotateAdminAccess\"}"
            );
            require(
                rotate.statusCode() == 200
                    && remoteAdminUrl.get().endsWith("token=new")
                    && activeSessions.get() == 0,
                "admin access rotation failed"
            );

            var reconnect = post(
                client,
                base,
                "{\"action\":\"reconnectSoop\"}"
            );
            require(
                reconnect.statusCode() == 200
                    && reconnects.get() == 1,
                "SOOP reconnect action failed"
            );

            System.out.println("[server-management-probe] PASS");
            return 0;
        } catch (Exception error) {
            System.err.println(
                "[server-management-probe] FAIL: "
                    + error.getMessage()
            );
            error.printStackTrace(System.err);
            return 1;
        } finally {
            if (server != null) {
                try { server.close(); } catch (Exception ignored) {}
            }
            if (root != null) {
                try (var paths = Files.walk(root)) {
                    paths.sorted((a, b) -> b.compareTo(a))
                        .forEach(path -> {
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

    private static HttpResponse<String> post(
        HttpClient client,
        URI base,
        String json
    ) throws Exception {
        return client.send(
            HttpRequest.newBuilder(
                base.resolve("/api/server-management")
            )
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json))
                .build(),
            HttpResponse.BodyHandlers.ofString()
        );
    }

    private static int freePort() throws Exception {
        try (var socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    private static void require(
        boolean condition,
        String message
    ) {
        if (!condition) {
            throw new IllegalStateException(message);
        }
    }
}
