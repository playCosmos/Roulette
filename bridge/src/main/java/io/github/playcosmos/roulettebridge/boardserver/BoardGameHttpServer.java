package io.github.playcosmos.roulettebridge.boardserver;

import com.google.gson.Gson;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.github.playcosmos.roulettebridge.room.RoomHttpHandler;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.function.IntSupplier;
import java.util.function.Supplier;

public final class BoardGameHttpServer implements AutoCloseable {
    private static final Gson GSON = new Gson();
    private static final String VERSION = "0.6.1";
    private static final String ROOM_ADMIN_UI_VERSION = "0.6.1";
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

    public BoardGameHttpServer(
        BoardServerConfig config,
        Path workingDirectory,
        Path databasePath,
        IntSupplier websocketClientCount,
        Supplier<Map<String, Object>> soopState,
        RoomHttpHandler rooms,
        Supplier<String> remoteAdminUrl,
        Supplier<String> localUserAdminUrl,
        IntSupplier adminSessionCount,
        Supplier<Integer> revokeAdminSessions,
        Supplier<String> rotateAdminAccess,
        Runnable reconnectSoop
    ) throws IOException {
        this.config = config.normalized();
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
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> request = GSON.fromJson(
                new String(body, StandardCharsets.UTF_8),
                Map.class
            );
            action = request == null
                ? null
                : String.valueOf(request.getOrDefault("action", ""));
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
        payload.put("soop", soopState.get());
        return payload;
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
