package io.github.playcosmos.roulettebridge.server;

import com.google.gson.Gson;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import io.github.playcosmos.roulettebridge.config.BridgeConfig;
import io.github.playcosmos.roulettebridge.recovery.TicketRecoveryService;
import io.github.playcosmos.roulettebridge.storage.TicketArchiveService;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.function.IntSupplier;
import java.util.function.Supplier;

public final class BridgeHttpServer implements AutoCloseable {
    private static final Gson GSON = new Gson();
    private static final int MAX_TICKET_PNG_BYTES = 20 * 1024 * 1024;
    private static final String TICKET_API_PREFIX = "/api/tickets/";

    private final HttpServer server;
    private final Path webRoot;
    private final TicketArchiveService ticketArchive;
    private final TicketRecoveryService recovery;
    private final String instanceId = UUID.randomUUID().toString();

    public BridgeHttpServer(
        BridgeConfig config,
        Path workingDirectory,
        Path databasePath,
        IntSupplier pendingTicketCount,
        IntSupplier websocketClientCount,
        Supplier<Map<String, Object>> soopState,
        TicketArchiveService ticketArchive,
        TicketRecoveryService recovery,
        HttpHandler adminOperations
    ) throws IOException {
        var host = config.server().host();
        var port = config.server().port();
        this.webRoot = resolveWebRoot(workingDirectory, config.storage().webRoot());
        this.ticketArchive = ticketArchive;
        this.recovery = recovery;
        this.server = HttpServer.create(new InetSocketAddress(host, port), 0);
        this.server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());

        server.createContext("/health", exchange -> {
            exchange.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
            exchange.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, OPTIONS");
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
                return;
            }
            sendJson(exchange, 200, Map.of(
                "status", "ok",
                "instanceId", instanceId,
                "time", OffsetDateTime.now().toString()
            ));
        });

        server.createContext("/api/state", exchange -> {
            var payload = new LinkedHashMap<String, Object>();
            payload.put("version", "0.6.0");
            payload.put("instanceId", instanceId);
            payload.put("streamerId", config.streamerId());
            payload.put("pendingTickets", pendingTicketCount.getAsInt());
            payload.put("websocketClients", websocketClientCount.getAsInt());
            payload.put("database", databasePath.toString());
            payload.put("ticketRoot", ticketArchive.ticketRoot().toString());
            payload.put("backupRoot", workingDirectory.resolve(config.storage().backupDirectory()).normalize().toString());
            payload.put("logRoot", workingDirectory.resolve(config.storage().logDirectory()).normalize().toString());
            payload.put("webRoot", webRoot.toString());
            payload.put("websocketUrl", "ws://" + host + ":" + config.server().websocketPort());
            payload.put("soop", soopState.get());
            sendJson(exchange, 200, payload);
        });

        server.createContext(TICKET_API_PREFIX, this::handleTicketApi);
        server.createContext("/api/admin", adminOperations);
        server.createContext("/", this::serveStatic);
    }

    public void start() {
        server.start();
        System.out.println("[http] listening on http://" + server.getAddress().getHostString() + ":" + server.getAddress().getPort());
        System.out.println("[http] web root: " + webRoot);
        System.out.println("[http] ticket root: " + ticketArchive.ticketRoot());
    }

    private void handleTicketApi(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(405, -1);
            exchange.close();
            return;
        }

        String path = exchange.getRequestURI().getPath();
        String suffix = path != null && path.startsWith(TICKET_API_PREFIX)
            ? path.substring(TICKET_API_PREFIX.length())
            : "";

        if (suffix.endsWith("/completed")) {
            String ticketId = decodeTicketId(suffix, "/completed");
            if (ticketId == null) {
                sendJson(exchange, 400, Map.of("error", "invalid ticket id"));
                return;
            }
            try {
                recovery.markCompleted(ticketId);
                sendJson(exchange, 200, Map.of("ticketId", ticketId, "status", "ROULETTE_COMPLETED"));
            } catch (NoSuchElementException error) {
                sendJson(exchange, 404, Map.of("error", error.getMessage()));
            } catch (SQLException error) {
                error.printStackTrace(System.err);
                sendJson(exchange, 500, Map.of("error", "database update failed"));
            }
            return;
        }

        if (!suffix.endsWith("/image")) {
            sendText(exchange, 404, "Not Found", "text/plain; charset=utf-8");
            return;
        }

        String ticketId = decodeTicketId(suffix, "/image");
        if (ticketId == null) {
            sendJson(exchange, 400, Map.of("error", "invalid ticket id"));
            return;
        }

        String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
        if (contentType == null || !contentType.toLowerCase().startsWith("image/png")) {
            sendJson(exchange, 415, Map.of("error", "Content-Type must be image/png"));
            return;
        }

        String contentLength = exchange.getRequestHeaders().getFirst("Content-Length");
        if (contentLength != null) {
            try {
                if (Long.parseLong(contentLength) > MAX_TICKET_PNG_BYTES) {
                    sendJson(exchange, 413, Map.of("error", "ticket PNG exceeds 20 MiB"));
                    return;
                }
            } catch (NumberFormatException ignored) {
                // bounded read below handles invalid or chunked content lengths.
            }
        }

        byte[] body = exchange.getRequestBody().readNBytes(MAX_TICKET_PNG_BYTES + 1);
        if (body.length > MAX_TICKET_PNG_BYTES) {
            sendJson(exchange, 413, Map.of("error", "ticket PNG exceeds 20 MiB"));
            return;
        }

        try {
            var result = ticketArchive.savePng(ticketId, body);
            sendJson(exchange, 200, result);
        } catch (NoSuchElementException error) {
            sendJson(exchange, 404, Map.of("error", error.getMessage()));
        } catch (IllegalArgumentException error) {
            sendJson(exchange, 400, Map.of("error", error.getMessage()));
        } catch (SQLException error) {
            error.printStackTrace(System.err);
            sendJson(exchange, 500, Map.of("error", "database update failed"));
        } catch (IOException error) {
            error.printStackTrace(System.err);
            sendJson(exchange, 500, Map.of("error", "ticket file save failed"));
        }
    }

    private static String decodeTicketId(String suffix, String actionSuffix) {
        String encodedTicketId = suffix.substring(0, suffix.length() - actionSuffix.length());
        if (encodedTicketId.isBlank() || encodedTicketId.contains("/")) return null;
        return URLDecoder.decode(encodedTicketId, StandardCharsets.UTF_8);
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
