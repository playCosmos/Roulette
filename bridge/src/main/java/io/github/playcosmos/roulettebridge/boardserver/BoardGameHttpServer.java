package io.github.playcosmos.roulettebridge.boardserver;

import com.google.gson.Gson;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.github.playcosmos.roulettebridge.room.RoomHttpHandler;
import java.io.IOException;
import java.net.InetSocketAddress;
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

    private final HttpServer server;
    private final Path webRoot;
    private final String instanceId = UUID.randomUUID().toString();
    private final BoardServerConfig config;

    public BoardGameHttpServer(
        BoardServerConfig config,
        Path workingDirectory,
        Path databasePath,
        IntSupplier websocketClientCount,
        Supplier<Map<String, Object>> soopState,
        RoomHttpHandler rooms
    ) throws IOException {
        this.config = config.normalized();
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
                "product", "RamyaniBoardGameServer",
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
            payload.put("product", "RamyaniBoardGameServer");
            payload.put("version", "0.2.0");
            payload.put("instanceId", instanceId);
            payload.put("streamerId", this.config.streamerId());
            payload.put("database", databasePath.toString());
            payload.put("webRoot", webRoot.toString());
            payload.put("websocketClients", websocketClientCount.getAsInt());
            payload.put(
                "websocketUrl",
                "ws://" + this.config.server().host() + ":" + this.config.server().websocketPort()
            );
            payload.put("soop", soopState.get());
            sendJson(exchange, 200, payload);
        });

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
        if ("/".equals(decoded)) decoded = "/board-admin.html";

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
