package io.github.playcosmos.roulettebridge.server;

import com.google.gson.Gson;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.github.playcosmos.roulettebridge.config.BridgeConfig;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.OffsetDateTime;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.function.IntSupplier;

public final class BridgeHttpServer implements AutoCloseable {
    private static final Gson GSON = new Gson();
    private final HttpServer server;
    private final Path webRoot;

    public BridgeHttpServer(
        BridgeConfig config,
        Path workingDirectory,
        Path databasePath,
        IntSupplier pendingTicketCount,
        IntSupplier websocketClientCount
    ) throws IOException {
        var host = config.server().host();
        var port = config.server().port();
        this.webRoot = resolveWebRoot(workingDirectory, config.storage().webRoot());
        this.server = HttpServer.create(new InetSocketAddress(host, port), 0);
        this.server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());

        server.createContext("/health", exchange -> sendJson(exchange, 200, Map.of(
            "status", "ok",
            "time", OffsetDateTime.now().toString()
        )));

        server.createContext("/api/state", exchange -> sendJson(exchange, 200, Map.of(
            "version", "0.1.0",
            "streamerId", config.streamerId(),
            "pendingTickets", pendingTicketCount.getAsInt(),
            "websocketClients", websocketClientCount.getAsInt(),
            "database", databasePath.toString(),
            "webRoot", webRoot.toString(),
            "websocketUrl", "ws://" + host + ":" + config.server().websocketPort()
        )));

        server.createContext("/", this::serveStatic);
    }

    public void start() {
        server.start();
        System.out.println("[http] listening on http://" + server.getAddress().getHostString() + ":" + server.getAddress().getPort());
        System.out.println("[http] web root: " + webRoot);
    }

    private void serveStatic(HttpExchange exchange) throws IOException {
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod()) && !"HEAD".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(405, -1);
            exchange.close();
            return;
        }

        String requestPath = URI.create(exchange.getRequestURI().toString()).getPath();
        if (requestPath == null || requestPath.isBlank() || "/".equals(requestPath)) {
            requestPath = "/soop-overlay.html";
        }

        Path file = webRoot.resolve(requestPath.substring(1)).normalize();
        if (!file.startsWith(webRoot) || Files.notExists(file) || Files.isDirectory(file)) {
            sendText(exchange, 404, "Not Found", "text/plain; charset=utf-8");
            return;
        }

        String contentType = contentType(file);
        exchange.getResponseHeaders().set("Content-Type", contentType);
        exchange.getResponseHeaders().set("Cache-Control", "no-cache");
        long size = Files.size(file);
        exchange.sendResponseHeaders(200, "HEAD".equalsIgnoreCase(exchange.getRequestMethod()) ? -1 : size);
        if (!"HEAD".equalsIgnoreCase(exchange.getRequestMethod())) {
            try (var output = exchange.getResponseBody()) {
                Files.copy(file, output);
            }
        } else {
            exchange.close();
        }
    }

    private static Path resolveWebRoot(Path workingDirectory, String configured) {
        Path requested = workingDirectory.resolve(configured).normalize().toAbsolutePath();
        if (Files.isDirectory(requested)) return requested;

        Path repoRoot = workingDirectory.getParent();
        if (repoRoot != null && Files.exists(repoRoot.resolve("soop-overlay.html"))) {
            return repoRoot.toAbsolutePath().normalize();
        }
        return requested;
    }

    private static void sendJson(HttpExchange exchange, int status, Object payload) throws IOException {
        sendText(exchange, status, GSON.toJson(payload), "application/json; charset=utf-8");
    }

    private static void sendText(HttpExchange exchange, int status, String text, String contentType) throws IOException {
        byte[] body = text.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", contentType);
        exchange.sendResponseHeaders(status, body.length);
        try (var output = exchange.getResponseBody()) {
            output.write(body);
        }
    }

    private static String contentType(Path file) {
        String name = file.getFileName().toString().toLowerCase();
        if (name.endsWith(".html")) return "text/html; charset=utf-8";
        if (name.endsWith(".css")) return "text/css; charset=utf-8";
        if (name.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (name.endsWith(".json")) return "application/json; charset=utf-8";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
        if (name.endsWith(".svg")) return "image/svg+xml";
        if (name.endsWith(".ttf")) return "font/ttf";
        return "application/octet-stream";
    }

    @Override
    public void close() {
        server.stop(0);
    }
}
