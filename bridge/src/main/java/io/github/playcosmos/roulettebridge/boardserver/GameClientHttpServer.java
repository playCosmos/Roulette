package io.github.playcosmos.roulettebridge.boardserver;

import com.google.gson.Gson;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.github.playcosmos.roulettebridge.room.BoardGameRuntimeEngine;
import io.github.playcosmos.roulettebridge.room.RoomService;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.OffsetDateTime;
import java.util.Map;
import java.util.concurrent.Executors;

public final class GameClientHttpServer implements AutoCloseable {
    private static final Gson GSON = new Gson();

    private final HttpServer server;
    private final Path webRoot;
    private final RoomService rooms;
    private final BoardGameRuntimeEngine runtime;
    private final BoardServerConfig config;

    public GameClientHttpServer(
        BoardServerConfig config,
        Path workingDirectory,
        RoomService rooms,
        BoardGameRuntimeEngine runtime
    ) throws IOException {
        var normalized = config.normalized();
        this.config = normalized;
        this.webRoot = resolveWebRoot(
            workingDirectory,
            normalized.storage().webRoot()
        );
        this.rooms = rooms;
        this.runtime = runtime;
        this.server = HttpServer.create(
            new InetSocketAddress(
                normalized.server().clientHost(),
                normalized.server().clientPort()
            ),
            0
        );
        this.server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());

        server.createContext("/health", this::health);
        server.createContext("/api/client/config", this::clientConfig);
        server.createContext("/api/board/rooms", this::readRoom);
        server.createContext("/games/board/", this::serveBoardAsset);
        server.createContext("/", exchange -> {
            exchange.sendResponseHeaders(404, -1);
            exchange.close();
        });
    }

    public void start() {
        server.start();
        System.out.println(
            "[board-client-http] listening on http://"
                + server.getAddress().getHostString()
                + ":" + server.getAddress().getPort()
        );
    }

    private void health(HttpExchange exchange) throws IOException {
        if (!requireGetOrHead(exchange)) return;
        sendJson(exchange, 200, Map.of(
            "status", "ok",
            "product", "RamyaniGamesClient",
            "time", OffsetDateTime.now().toString()
        ));
    }

    private void clientConfig(HttpExchange exchange) throws IOException {
        cors(exchange);
        if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
            return;
        }
        if (!requireGetOrHead(exchange)) return;

        sendJson(exchange, 200, Map.of(
            "websocketUrl",
            resolvedWebSocketUrl(exchange)
        ));
    }

    private String resolvedWebSocketUrl(HttpExchange exchange) {
        String configured = config.server().publicWebSocketUrl();
        if (configured != null && !configured.isBlank()) {
            return configured;
        }

        String host = exchange.getRequestHeaders().getFirst("X-Forwarded-Host");
        if (host == null || host.isBlank()) {
            host = exchange.getRequestHeaders().getFirst("Host");
        }
        if (host == null || host.isBlank()) {
            host = "127.0.0.1";
        }

        int comma = host.indexOf(',');
        if (comma >= 0) host = host.substring(0, comma).trim();

        String hostname = host;
        if (host.startsWith("[")) {
            int close = host.indexOf(']');
            if (close > 0) hostname = host.substring(0, close + 1);
        } else {
            int colon = host.lastIndexOf(':');
            if (colon > 0 && host.indexOf(':') == colon) {
                hostname = host.substring(0, colon);
            }
        }

        String forwardedProto = exchange.getRequestHeaders().getFirst(
            "X-Forwarded-Proto"
        );
        String scheme = forwardedProto != null
            && forwardedProto.trim().equalsIgnoreCase("https")
            ? "wss"
            : "ws";

        return scheme + "://" + hostname
            + ":" + config.server().websocketPort();
    }

    private void readRoom(HttpExchange exchange) throws IOException {
        cors(exchange);
        if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
            return;
        }
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendJson(exchange, 405, Map.of(
                "error",
                "client endpoint is read-only"
            ));
            return;
        }

        String base = "/api/board/rooms/";
        String path = exchange.getRequestURI().getPath();
        if (path == null || !path.startsWith(base) || path.length() <= base.length()) {
            sendJson(exchange, 404, Map.of("error", "room not found"));
            return;
        }

        String route = path.substring(base.length());
        try {
            if (route.endsWith("/runtime")) {
                String roomId = route.substring(
                    0,
                    route.length() - "/runtime".length()
                );
                sendJson(exchange, 200, runtime.snapshot(roomId));
                return;
            }

            if (route.contains("/")) {
                sendJson(exchange, 404, Map.of("error", "route not found"));
                return;
            }

            sendJson(exchange, 200, rooms.find(route));
        } catch (Exception error) {
            sendJson(
                exchange,
                error instanceof java.util.NoSuchElementException ? 404 : 400,
                Map.of("error", safeMessage(error))
            );
        }
    }

    private void serveBoardAsset(HttpExchange exchange) throws IOException {
        if (!requireGetOrHead(exchange)) return;

        String rawPath = exchange.getRequestURI().getPath();
        String decoded = URLDecoder.decode(
            rawPath == null ? "" : rawPath,
            StandardCharsets.UTF_8
        );

        if (!decoded.startsWith("/games/board/")) {
            exchange.sendResponseHeaders(404, -1);
            exchange.close();
            return;
        }

        Path requested = webRoot
            .resolve(decoded.substring(1))
            .normalize();
        Path allowedRoot = webRoot.resolve("games/board").normalize();

        if (
            !requested.startsWith(allowedRoot)
            || !Files.isRegularFile(requested)
        ) {
            exchange.sendResponseHeaders(404, -1);
            exchange.close();
            return;
        }

        byte[] body = Files.readAllBytes(requested);
        exchange.getResponseHeaders().set(
            "Content-Type",
            contentType(requested)
        );
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

    private static boolean requireGetOrHead(
        HttpExchange exchange
    ) throws IOException {
        if (
            "GET".equalsIgnoreCase(exchange.getRequestMethod())
            || "HEAD".equalsIgnoreCase(exchange.getRequestMethod())
        ) {
            return true;
        }
        exchange.sendResponseHeaders(405, -1);
        exchange.close();
        return false;
    }

    private static Path resolveWebRoot(
        Path workingDirectory,
        String configured
    ) {
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
        exchange.getResponseHeaders().set(
            "Access-Control-Allow-Origin",
            "*"
        );
        exchange.getResponseHeaders().set(
            "Access-Control-Allow-Methods",
            "GET, HEAD, OPTIONS"
        );
        exchange.getResponseHeaders().set(
            "Access-Control-Allow-Headers",
            "Content-Type"
        );
    }

    private static void sendJson(
        HttpExchange exchange,
        int status,
        Object payload
    ) throws IOException {
        byte[] body = GSON.toJson(payload).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set(
            "Content-Type",
            "application/json; charset=utf-8"
        );
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        cors(exchange);
        exchange.sendResponseHeaders(status, body.length);
        try (var output = exchange.getResponseBody()) {
            output.write(body);
        }
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isBlank()
            ? error.getClass().getSimpleName()
            : message;
    }

    @Override
    public void close() {
        server.stop(1);
    }
}
