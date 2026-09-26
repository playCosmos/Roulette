package io.github.playcosmos.roulettebridge.boardserver;

import com.sun.net.httpserver.HttpServer;
import io.github.playcosmos.roulettebridge.room.BoardGameRuntimeEngine;
import io.github.playcosmos.roulettebridge.room.RoomService;
import java.net.InetSocketAddress;
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
        HttpServer mockAdmin = null;
        try {
            root = Files.createTempDirectory(
                "games-client-boundary-"
            );
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

            mockAdmin = HttpServer.create(
                new InetSocketAddress("127.0.0.1", adminPort),
                0
            );
            mockAdmin.createContext("/", exchange -> {
                String path = exchange.getRequestURI().getPath();
                byte[] body;
                int status;

                if ("/api/state".equals(path)) {
                    status = 200;
                    body = "{\"source\":\"local-admin\"}"
                        .getBytes(StandardCharsets.UTF_8);
                } else if (
                    path.startsWith("/api/board/rooms")
                    && "POST".equalsIgnoreCase(
                        exchange.getRequestMethod()
                    )
                ) {
                    status = 200;
                    body = "{\"proxied\":true}"
                        .getBytes(StandardCharsets.UTF_8);
                } else {
                    status = 404;
                    body = "{\"error\":\"not found\"}"
                        .getBytes(StandardCharsets.UTF_8);
                }

                exchange.getResponseHeaders().set(
                    "Content-Type",
                    "application/json; charset=utf-8"
                );
                exchange.sendResponseHeaders(status, body.length);
                try (var output = exchange.getResponseBody()) {
                    output.write(body);
                }
            });
            mockAdmin.start();

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
            var rooms = new RoomService(
                database,
                players -> players
            );
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

            var client = HttpClient.newBuilder()
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
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

            var configResponse = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/client/config")
                ).GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                configResponse.statusCode() == 200,
                "client config must be public"
            );
            require(
                configResponse.body().contains(
                    "\"websocketUrl\":\"ws://127.0.0.1:"
                        + websocketPort
                ),
                "client config must expose websocket URL"
            );

            var hiddenAdminResponse = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/board-admin.html")
                ).GET().build(),
                HttpResponse.BodyHandlers.discarding()
            );
            require(
                hiddenAdminResponse.statusCode() == 404,
                "raw admin page must not be exposed"
            );

            var unauthenticatedAdminPage = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/admin/")
                ).GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                unauthenticatedAdminPage.statusCode() == 401,
                "admin path must require authentication"
            );

            var unauthenticatedPost = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/board/rooms")
                )
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{}"))
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                unauthenticatedPost.statusCode() == 401,
                "room mutation must require admin session"
            );

            var bootstrapResponse = client.send(
                HttpRequest.newBuilder(
                    URI.create(server.adminBootstrapUrl())
                ).GET().build(),
                HttpResponse.BodyHandlers.discarding()
            );
            require(
                bootstrapResponse.statusCode() == 303,
                "bootstrap token must redirect after authentication"
            );
            require(
                "/admin/board-admin.html".equals(
                    bootstrapResponse.headers()
                        .firstValue("Location")
                        .orElse("")
                ),
                "bootstrap redirect target mismatch"
            );

            String setCookie = bootstrapResponse.headers()
                .firstValue("Set-Cookie")
                .orElseThrow(() -> new IllegalStateException(
                    "admin session cookie missing"
                ));
            require(
                setCookie.contains("HttpOnly"),
                "admin session cookie must be HttpOnly"
            );
            require(
                setCookie.contains("SameSite=Strict"),
                "admin session cookie must be SameSite=Strict"
            );
            String sessionCookie = setCookie.split(";", 2)[0];

            var authenticatedAdminPage = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/admin/board-admin.html")
                )
                .header("Cookie", sessionCookie)
                .GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                authenticatedAdminPage.statusCode() == 200,
                "authenticated admin page must be served"
            );

            var stateResponse = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/state")
                )
                .header("Cookie", sessionCookie)
                .GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                stateResponse.statusCode() == 200
                    && stateResponse.body().contains(
                        "\"source\":\"local-admin\""
                    ),
                "authenticated state API must proxy to local admin"
            );

            var authenticatedPost = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/board/rooms")
                )
                .header("Cookie", sessionCookie)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{}"))
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                authenticatedPost.statusCode() == 200
                    && authenticatedPost.body().contains(
                        "\"proxied\":true"
                    ),
                "authenticated mutation must proxy to local admin"
            );

            System.out.println("[client-boundary-probe] PASS");
            return 0;
        } catch (Exception error) {
            System.err.println(
                "[client-boundary-probe] FAIL: "
                    + error.getMessage()
            );
            error.printStackTrace(System.err);
            return 1;
        } finally {
            if (server != null) {
                try { server.close(); } catch (Exception ignored) {}
            }
            if (mockAdmin != null) {
                try { mockAdmin.stop(0); } catch (Exception ignored) {}
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
