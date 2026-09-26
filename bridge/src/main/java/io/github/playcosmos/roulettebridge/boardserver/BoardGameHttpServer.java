package io.github.playcosmos.roulettebridge.boardserver;

import com.google.gson.Gson;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.github.playcosmos.roulettebridge.room.RoomHttpHandler;
import io.github.playcosmos.roulettebridge.room.RoomService;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.function.IntSupplier;
import java.util.function.Supplier;

public final class BoardGameHttpServer implements AutoCloseable {
    private static final Gson GSON = new Gson();
    private static final String VERSION = "0.8.1";
    private static final String ROOM_ADMIN_UI_VERSION = "0.8.1";
    private static final int MAX_MANAGEMENT_BODY_BYTES = 16 * 1024;

    private final HttpServer server;
    private final Path webRoot;
    private final String instanceId = UUID.randomUUID().toString();
    private final String startedAt = OffsetDateTime.now().toString();
    private final BoardServerConfig config;
    private final Supplier<String> remoteAdminUrl;
    private final Supplier<String> localUserAdminUrl;
    private final IntSupplier adminSessionCount;
    private final Supplier<Integer> revokeAdminSessions;
    private final Supplier<String> rotateAdminAccess;
    private final Runnable reconnectSoop;
    private final RoomService roomService;
    private final ServerPolicyService serverPolicies;

    public BoardGameHttpServer(
        BoardServerConfig config,
        Path workingDirectory,
        Path databasePath,
        IntSupplier websocketClientCount,
        Supplier<Map<String, Object>> soopState,
        RoomHttpHandler rooms,
        RoomService roomService,
        ServerPolicyService serverPolicies,
        Supplier<String> remoteAdminUrl,
        Supplier<String> localUserAdminUrl,
        IntSupplier adminSessionCount,
        Supplier<Integer> revokeAdminSessions,
        Supplier<String> rotateAdminAccess,
        Runnable reconnectSoop
    ) throws IOException {
        this.config = config.normalized();
        this.roomService = roomService;
        this.serverPolicies = serverPolicies;
        this.remoteAdminUrl = remoteAdminUrl;
        this.localUserAdminUrl = localUserAdminUrl;
        this.adminSessionCount = adminSessionCount;
        this.revokeAdminSessions = revokeAdminSessions;
        this.rotateAdminAccess = rotateAdminAccess;
        this.reconnectSoop = reconnectSoop;
        this.webRoot = resolveWebRoot(workingDirectory, this.config.storage().webRoot());
        this.server = HttpServer.create(
            new InetSocketAddress(this.config.server().host(), this.config.server().port()),
            0
        );
        this.server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());

        server.createContext("/health", exchange -> {
            cors(exchange);
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
                return;
            }
            sendJson(exchange, 200, Map.of(
                "status", "ok",
                "product", "RamyaniGamesServer",
                "instanceId", instanceId,
                "time", OffsetDateTime.now().toString()
            ));
        });

        server.createContext("/api/state", exchange -> {
            cors(exchange);
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
                return;
            }
            var payload = new LinkedHashMap<String, Object>();
            String clientBaseUrl = clientBaseUrl(exchange);
            String websocketUrl = websocketUrl(exchange, clientBaseUrl);

            payload.put("product", "RamyaniGamesServer");
            payload.put("version", VERSION);
            payload.put("roomAdminUiVersion", ROOM_ADMIN_UI_VERSION);
            payload.put("instanceId", instanceId);
            payload.put("streamerId", this.config.streamerId());
            payload.put("database", databasePath.toString());
            payload.put("webRoot", webRoot.toString());
            payload.put("websocketClients", websocketClientCount.getAsInt());
            payload.put("clientBaseUrl", clientBaseUrl);
            payload.put("websocketUrl", websocketUrl);
            payload.put(
                "sharingConfigured",
                !this.config.server().publicBaseUrl().isBlank()
                    && !this.config.server().publicWebSocketUrl().isBlank()
            );
            payload.put("clientPort", this.config.server().clientPort());
            payload.put("websocketPort", this.config.server().websocketPort());
            payload.put("remoteAdminUrl", remoteAdminUrl.get());
            payload.put("remoteAdminSessionHours", 12);
            try {
                var activeRooms = roomService.listActiveRoomSummaries();
                payload.put(
                    "activeRoomLimit",
                    serverPolicies.activeRoomLimit()
                );
                payload.put("activeRoomCount", activeRooms.size());
            } catch (Exception error) {
                payload.put(
                    "activeRoomLimit",
                    serverPolicies.activeRoomLimit()
                );
                payload.put("activeRoomCount", 0);
            }
            payload.put("soop", soopState.get());
            sendJson(exchange, 200, payload);
        });

        server.createContext(
            "/api/server-management",
            exchange -> serverManagement(
                exchange,
                databasePath,
                websocketClientCount,
                soopState
            )
        );
        server.createContext("/api/board/rooms", rooms);
        server.createContext("/", this::serveStatic);
    }

    public void start() {
        server.start();
        System.out.println(
            "[board-http] listening on http://" +
            server.getAddress().getHostString() + ":" + server.getAddress().getPort()
        );
        System.out.println("[board-http] web root: " + webRoot);
    }

    private void serverManagement(
        HttpExchange exchange,
        Path databasePath,
        IntSupplier websocketClientCount,
        Supplier<Map<String, Object>> soopState
    ) throws IOException {
        String method = exchange.getRequestMethod();
        if ("GET".equalsIgnoreCase(method)) {
            sendJson(
                exchange,
                200,
                managementState(
                    exchange,
                    databasePath,
                    websocketClientCount,
                    soopState
                )
            );
            return;
        }

        if (!"POST".equalsIgnoreCase(method)) {
            exchange.sendResponseHeaders(405, -1);
            exchange.close();
            return;
        }

        byte[] body = exchange.getRequestBody()
            .readNBytes(MAX_MANAGEMENT_BODY_BYTES + 1);
        if (body.length > MAX_MANAGEMENT_BODY_BYTES) {
            sendJson(
                exchange,
                413,
                Map.of("error", "management request is too large")
            );
            return;
        }

        String action;
        Map<String, Object> request;
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> parsed = GSON.fromJson(
                new String(body, StandardCharsets.UTF_8),
                Map.class
            );
            request = parsed == null ? Map.of() : parsed;
            action = String.valueOf(request.getOrDefault("action", ""));
        } catch (Exception error) {
            sendJson(exchange, 400, Map.of("error", "invalid JSON"));
            return;
        }

        var result = new LinkedHashMap<String, Object>();
        switch (action == null ? "" : action) {
            case "revokeAdminSessions" -> {
                int revoked = revokeAdminSessions.get();
                result.put("action", action);
                result.put("revokedSessions", revoked);
            }
            case "rotateAdminAccess" -> {
                String nextUrl = rotateAdminAccess.get();
                result.put("action", action);
                result.put("remoteAdminUrl", nextUrl);
                result.put("revokedSessions", true);
            }
            case "reconnectSoop" -> {
                reconnectSoop.run();
                result.put("action", action);
                result.put("requested", true);
            }
            case "setActiveRoomLimit" -> {
                int value;
                try {
                    value = integerValue(
                        request.get("activeRoomLimit"),
                        "activeRoomLimit"
                    );
                    value = serverPolicies.setActiveRoomLimit(value);
                } catch (IllegalArgumentException error) {
                    sendJson(
                        exchange,
                        400,
                        Map.of("error", safeMessage(error))
                    );
                    return;
                } catch (Exception error) {
                    sendJson(
                        exchange,
                        500,
                        Map.of("error", "failed to update active room limit")
                    );
                    return;
                }
                result.put("action", action);
                result.put("activeRoomLimit", value);
                result.put("existingRoomsUnchanged", true);
            }
            case "terminateRoom" -> {
                String roomId = String.valueOf(
                    request.getOrDefault("roomId", "")
                ).trim();
                if (roomId.isBlank()) {
                    sendJson(
                        exchange,
                        400,
                        Map.of("error", "roomId is required")
                    );
                    return;
                }
                try {
                    var terminated = roomService.terminate(roomId);
                    result.put("action", action);
                    result.put("terminatedRoomId", terminated.roomId());
                } catch (java.util.NoSuchElementException error) {
                    sendJson(
                        exchange,
                        404,
                        Map.of("error", safeMessage(error))
                    );
                    return;
                } catch (Exception error) {
                    sendJson(
                        exchange,
                        400,
                        Map.of("error", safeMessage(error))
                    );
                    return;
                }
            }
            default -> {
                sendJson(
                    exchange,
                    400,
                    Map.of("error", "unsupported management action")
                );
                return;
            }
        }

        result.put(
            "state",
            managementState(
                exchange,
                databasePath,
                websocketClientCount,
                soopState
            )
        );
        sendJson(exchange, 200, result);
    }

    private Map<String, Object> managementState(
        HttpExchange exchange,
        Path databasePath,
        IntSupplier websocketClientCount,
        Supplier<Map<String, Object>> soopState
    ) {
        var payload = new LinkedHashMap<String, Object>();
        String clientBaseUrl = clientBaseUrl(exchange);
        String websocketUrl = websocketUrl(exchange, clientBaseUrl);

        payload.put("product", "RamyaniGamesServer");
        payload.put("version", VERSION);
        payload.put("roomAdminUiVersion", ROOM_ADMIN_UI_VERSION);
        payload.put("instanceId", instanceId);
        payload.put("startedAt", startedAt);
        payload.put("time", OffsetDateTime.now().toString());
        payload.put("streamerId", this.config.streamerId());
        payload.put("database", databasePath.toString());
        payload.put("webRoot", webRoot.toString());
        payload.put("adminHost", this.config.server().host());
        payload.put("adminPort", this.config.server().port());
        payload.put("clientHost", this.config.server().clientHost());
        payload.put("clientPort", this.config.server().clientPort());
        payload.put("websocketPort", this.config.server().websocketPort());
        payload.put("websocketClients", websocketClientCount.getAsInt());
        payload.put("activeAdminSessions", adminSessionCount.getAsInt());
        payload.put("adminSessionHours", 12);
        payload.put("clientBaseUrl", clientBaseUrl);
        payload.put("websocketUrl", websocketUrl);
        payload.put("remoteAdminUrl", remoteAdminUrl.get());
        payload.put("localUserAdminUrl", localUserAdminUrl.get());
        payload.put(
            "sharingConfigured",
            !this.config.server().publicBaseUrl().isBlank()
                && !this.config.server().publicWebSocketUrl().isBlank()
        );

        try {
            var activeRooms = roomService.listActiveRoomSummaries();
            var summaries = new ArrayList<Map<String, Object>>(
                activeRooms.size()
            );
            Instant now = Instant.now();
            for (var room : activeRooms) {
                var summary = new LinkedHashMap<String, Object>();
                summary.put("roomId", room.roomId());
                summary.put("name", room.name());
                summary.put("lifecycleState", room.lifecycleState());
                summary.put("playerCount", room.playerCount());
                summary.put("activatedAt", room.activatedAt());
                summary.put("createdAt", room.createdAt());
                summary.put("updatedAt", room.updatedAt());
                summary.put("expiresAt", room.expiresAt());
                summary.put(
                    "pauseDonationMode",
                    room.pauseDonationMode()
                );
                summary.put(
                    "queuedDonations",
                    room.queuedDonations()
                );

                Instant activatedAt = managementInstant(
                    room.activatedAt()
                );
                Instant expiresAt = managementInstant(
                    room.expiresAt()
                );
                long elapsedSeconds = activatedAt == null
                    ? 0L
                    : Math.max(
                        0L,
                        Duration.between(activatedAt, now).getSeconds()
                    );
                Long remainingSeconds = expiresAt == null
                    ? null
                    : Math.max(
                        0L,
                        Duration.between(now, expiresAt).getSeconds()
                    );
                summary.put("elapsedSeconds", elapsedSeconds);
                summary.put("remainingSeconds", remainingSeconds);
                summaries.add(summary);
            }

            int activeRoomLimit = serverPolicies.activeRoomLimit();
            payload.put("activeRoomLimit", activeRoomLimit);
            payload.put("activeRoomCount", summaries.size());
            payload.put(
                "activeRoomOverLimit",
                summaries.size() > activeRoomLimit
            );
            payload.put("activeRooms", summaries);
        } catch (Exception error) {
            payload.put("activeRoomLimit", serverPolicies.activeRoomLimit());
            payload.put("activeRoomCount", 0);
            payload.put("activeRoomOverLimit", false);
            payload.put("activeRooms", java.util.List.of());
            payload.put("activeRoomsError", safeMessage(error));
        }

        payload.put("soop", soopState.get());
        return payload;
    }

    private static Instant managementInstant(String value) {
        if (value == null || value.isBlank()) return null;
        String normalized = value.trim();
        try {
            return OffsetDateTime.parse(normalized).toInstant();
        } catch (java.time.format.DateTimeParseException ignored) {
        }
        try {
            return Instant.parse(normalized);
        } catch (java.time.format.DateTimeParseException ignored) {
        }
        try {
            return LocalDateTime.parse(
                normalized.replace(' ', 'T')
            ).toInstant(ZoneOffset.UTC);
        } catch (java.time.format.DateTimeParseException ignored) {
            return null;
        }
    }

    private static int integerValue(
        Object value,
        String field
    ) {
        if (value instanceof Number number) {
            double raw = number.doubleValue();
            int integer = (int) raw;
            if (raw != integer) {
                throw new IllegalArgumentException(
                    field + " must be an integer"
                );
            }
            return integer;
        }
        if (value instanceof String text) {
            try {
                return Integer.parseInt(text.trim());
            } catch (NumberFormatException error) {
                throw new IllegalArgumentException(
                    field + " must be an integer"
                );
            }
        }
        throw new IllegalArgumentException(field + " is required");
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isBlank()
            ? error.getClass().getSimpleName()
            : message;
    }

    private void serveStatic(HttpExchange exchange) throws IOException {
        if (
            !"GET".equalsIgnoreCase(exchange.getRequestMethod())
            && !"HEAD".equalsIgnoreCase(exchange.getRequestMethod())
        ) {
            exchange.sendResponseHeaders(405, -1);
            exchange.close();
            return;
        }

        String rawPath = exchange.getRequestURI().getPath();
        String decoded = URLDecoder.decode(rawPath == null ? "/" : rawPath, StandardCharsets.UTF_8);
        if ("/".equals(decoded)) decoded = "/server-management.html";

        Path requested = webRoot.resolve(decoded.substring(1)).normalize();
        if (!requested.startsWith(webRoot) || !Files.isRegularFile(requested)) {
            exchange.sendResponseHeaders(404, -1);
            exchange.close();
            return;
        }

        byte[] body = Files.readAllBytes(requested);
        exchange.getResponseHeaders().set("Content-Type", contentType(requested));
        exchange.getResponseHeaders().set("Cache-Control", "no-cache");
        if ("HEAD".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
            return;
        }
        exchange.sendResponseHeaders(200, body.length);
        try (var output = exchange.getResponseBody()) {
            output.write(body);
        }
    }

    private String clientBaseUrl(HttpExchange exchange) {
        String configured = config.server().publicBaseUrl();
        if (configured != null && !configured.isBlank()) {
            return stripTrailingSlash(configured);
        }

        String host = requestHost(exchange);
        String hostname = hostNameOnly(host);
        return "http://" + formatHost(hostname)
            + ":" + config.server().clientPort();
    }

    private String websocketUrl(
        HttpExchange exchange,
        String clientBaseUrl
    ) {
        String configured = config.server().publicWebSocketUrl();
        if (configured != null && !configured.isBlank()) {
            return stripTrailingSlash(configured);
        }

        String hostname = hostNameOnly(requestHost(exchange));
        String scheme = clientBaseUrl.startsWith("https://") ? "wss" : "ws";
        return scheme + "://" + formatHost(hostname)
            + ":" + config.server().websocketPort();
    }

    private static String requestHost(HttpExchange exchange) {
        String forwarded = exchange.getRequestHeaders().getFirst(
            "X-Forwarded-Host"
        );
        if (forwarded != null && !forwarded.isBlank()) {
            int comma = forwarded.indexOf(',');
            return (comma >= 0 ? forwarded.substring(0, comma) : forwarded)
                .trim();
        }

        String host = exchange.getRequestHeaders().getFirst("Host");
        if (host != null && !host.isBlank()) return host.trim();

        return "127.0.0.1";
    }

    private static String hostNameOnly(String host) {
        try {
            URI uri = URI.create("http://" + host);
            String hostname = uri.getHost();
            if (hostname != null && !hostname.isBlank()) return hostname;
        } catch (RuntimeException ignored) {
        }

        int colon = host.lastIndexOf(':');
        if (colon > 0 && host.indexOf(':') == colon) {
            return host.substring(0, colon);
        }
        return host;
    }

    private static String formatHost(String host) {
        if (host.contains(":") && !host.startsWith("[")) {
            return "[" + host + "]";
        }
        return host;
    }

    private static String stripTrailingSlash(String value) {
        String result = value.trim();
        while (result.endsWith("/")) {
            result = result.substring(0, result.length() - 1);
        }
        return result;
    }

    private static Path resolveWebRoot(Path workingDirectory, String configured) {
        Path path = Path.of(configured);
        return (path.isAbsolute() ? path : workingDirectory.resolve(path))
            .toAbsolutePath()
            .normalize();
    }

    private static String contentType(Path path) {
        String name = path.getFileName().toString().toLowerCase();
        if (name.endsWith(".html")) return "text/html; charset=utf-8";
        if (name.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (name.endsWith(".css")) return "text/css; charset=utf-8";
        if (name.endsWith(".json")) return "application/json; charset=utf-8";
        if (name.endsWith(".svg")) return "image/svg+xml";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
        if (name.endsWith(".webp")) return "image/webp";
        if (name.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    private static void cors(HttpExchange exchange) {
        exchange.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        exchange.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        exchange.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type");
    }

    private static void sendJson(HttpExchange exchange, int status, Object payload) throws IOException {
        byte[] body = GSON.toJson(payload).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, body.length);
        try (var output = exchange.getResponseBody()) {
            output.write(body);
        }
    }

    @Override
    public void close() {
        server.stop(1);
    }
}
