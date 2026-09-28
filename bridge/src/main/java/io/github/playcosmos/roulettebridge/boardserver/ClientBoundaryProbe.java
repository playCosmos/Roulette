package io.github.playcosmos.roulettebridge.boardserver;

import com.google.gson.JsonParser;
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
import java.util.List;

import static io.github.playcosmos.roulettebridge.room.RoomModels.*;

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

            var adminAuthStore = new AdminAuthStore(database);
            server = new GameClientHttpServer(
                config,
                root,
                rooms,
                runtime,
                adminAuthStore
            );
            server.start();
            require(
                server.localAdminBootstrapUrl().startsWith(
                    "http://127.0.0.1:" + clientPort + "/admin/?token="
                ),
                "local user-facing admin URL must use client port"
            );

            var client = HttpClient.newBuilder()
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
            URI base = URI.create(
                "http://127.0.0.1:" + clientPort
            );

            var roomRequest = new CreateRoomRequest(
                "Room Code Boundary",
                List.of(new PlayerInput("soop-a", "A", null, 100)),
                new BoardInput("dimensions", 8, 6, null, "rounded"),
                new MovementInput("dice", 1, false, false, false),
                new RulesInput("destinationOnly", true, true),
                List.of(),
                new RandomPoolInput("custom", List.of(), null)
            );
            var draftRoom = rooms.create(roomRequest);
            String roomCode = draftRoom.roomId();
            require(
                roomCode.length() == 6,
                "room code must be six characters"
            );

            var draftCodeRead = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/board/rooms/" + roomCode
                            + "?roomCode=" + roomCode
                    )
                ).GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                draftCodeRead.statusCode() == 401,
                "draft room code must not authorize public overlay reads"
            );

            rooms.commitPreview(roomCode);

            var missingCodeRead = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/board/rooms/" + roomCode)
                ).GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                missingCodeRead.statusCode() == 401,
                "public room read must require the six-character room code"
            );

            String wrongRoomCode = roomCode.equals("AAAAAA")
                ? "BBBBBB"
                : "AAAAAA";
            var wrongCodeRead = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/board/rooms/" + roomCode
                            + "?roomCode=" + wrongRoomCode
                    )
                ).GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                wrongCodeRead.statusCode() == 401,
                "wrong room code must not authorize public overlay reads"
            );

            var roomCodeRead = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/board/rooms/" + roomCode
                            + "?roomCode=" + roomCode
                    )
                ).GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                roomCodeRead.statusCode() == 200
                    && roomCodeRead.body().contains(
                        "\"roomId\":\"" + roomCode + "\""
                    ),
                "committed room code must authorize room snapshot reads"
            );

            var runtimeCodeRead = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/board/rooms/" + roomCode
                            + "/runtime?roomCode=" + roomCode
                    )
                ).GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                runtimeCodeRead.statusCode() == 200
                    && runtimeCodeRead.body().contains(
                        "\"roomId\":\"" + roomCode + "\""
                    ),
                "committed room code must authorize runtime reads"
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
            require(
                unauthenticatedAdminPage.body().contains("name=\"token\"")
                    && unauthenticatedAdminPage.body().contains(
                        "requestApproval"
                    ),
                "admin authentication page must offer token entry and approval request"
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

            require(
                adminAuthStore.countActiveSessions(
                    java.time.Instant.now()
                ) == 1,
                "bootstrap authentication must create exactly one session"
            );

            var repeatedBootstrap = client.send(
                HttpRequest.newBuilder(
                    URI.create(server.adminBootstrapUrl())
                )
                .header("Cookie", sessionCookie)
                .GET().build(),
                HttpResponse.BodyHandlers.discarding()
            );
            require(
                repeatedBootstrap.statusCode() == 303,
                "existing admin session must redirect from bootstrap URL"
            );
            require(
                repeatedBootstrap.headers()
                    .firstValue("Set-Cookie")
                    .isEmpty(),
                "existing admin session must not receive a replacement session cookie"
            );
            require(
                adminAuthStore.countActiveSessions(
                    java.time.Instant.now()
                ) == 1,
                "reopening bootstrap URL with an existing session must not increase session count"
            );

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

            String bootstrapBeforeRestart =
                server.adminBootstrapUrl();
            server.close();
            server = new GameClientHttpServer(
                config,
                root,
                rooms,
                runtime,
                new AdminAuthStore(database)
            );
            server.start();

            require(
                bootstrapBeforeRestart.equals(
                    server.adminBootstrapUrl()
                ),
                "bootstrap token must persist across server restart"
            );

            var afterRestartAdminPage = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/admin/board-admin.html")
                )
                .header("Cookie", sessionCookie)
                .GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                afterRestartAdminPage.statusCode() == 200,
                "admin session must survive server restart"
            );

            var afterRestartState = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/state")
                )
                .header("Cookie", sessionCookie)
                .GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                afterRestartState.statusCode() == 200
                    && afterRestartState.body().contains(
                        "\"source\":\"local-admin\""
                    ),
                "persisted admin session must authorize after restart"
            );

            var repeatedBootstrapAfterRestart = client.send(
                HttpRequest.newBuilder(
                    URI.create(server.adminBootstrapUrl())
                )
                .header("Cookie", sessionCookie)
                .GET().build(),
                HttpResponse.BodyHandlers.discarding()
            );
            require(
                repeatedBootstrapAfterRestart.statusCode() == 303
                    && repeatedBootstrapAfterRestart.headers()
                        .firstValue("Set-Cookie")
                        .isEmpty(),
                "persisted session must be reused when bootstrap URL is reopened after restart"
            );
            require(
                new AdminAuthStore(database).countActiveSessions(
                    java.time.Instant.now()
                ) == 1,
                "server restart plus existing browser access must not duplicate admin sessions"
            );

            var approvalRequest = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/api/admin/access/request")
                )
                .POST(HttpRequest.BodyPublishers.noBody())
                .build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                approvalRequest.statusCode() == 201,
                "unauthenticated browser must be able to request admin approval"
            );
            var approvalJson = JsonParser.parseString(
                approvalRequest.body()
            ).getAsJsonObject();
            String requestId = approvalJson
                .get("requestId")
                .getAsString();
            String approvalCode = approvalJson
                .get("approvalCode")
                .getAsString();
            require(
                approvalCode.matches("[A-HJ-NP-Z2-9]{6}"),
                "approval code must be six unambiguous characters"
            );
            require(
                server.pendingAdminApprovalCount() == 1,
                "pending admin approval must be visible to server manager"
            );
            require(
                server.approveAdminAccess(approvalCode),
                "server manager must be able to approve pending code"
            );

            var approvalStatus = client.send(
                HttpRequest.newBuilder(
                    base.resolve(
                        "/api/admin/access/status?requestId="
                            + requestId
                    )
                )
                .GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                approvalStatus.statusCode() == 200
                    && approvalStatus.body().contains(
                        "\"status\":\"APPROVED\""
                    ),
                "approved request must exchange for an admin session"
            );
            String approvalCookie = approvalStatus.headers()
                .firstValue("Set-Cookie")
                .orElseThrow(() -> new IllegalStateException(
                    "approved browser session cookie missing"
                ))
                .split(";", 2)[0];

            var approvedAdminPage = client.send(
                HttpRequest.newBuilder(
                    base.resolve("/admin/board-admin.html")
                )
                .header("Cookie", approvalCookie)
                .GET().build(),
                HttpResponse.BodyHandlers.ofString()
            );
            require(
                approvedAdminPage.statusCode() == 200,
                "approved browser must enter administrator page"
            );
            require(
                server.pendingAdminApprovalCount() == 0,
                "approved request must be one-time and consumed"
            );
            require(
                new AdminAuthStore(database).countActiveSessions(
                    java.time.Instant.now()
                ) == 2,
                "approval of a second browser must add exactly one admin session"
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
