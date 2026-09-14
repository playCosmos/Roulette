package io.github.playcosmos.roulettebridge.operations;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import io.github.playcosmos.roulettebridge.config.BridgeConfig;
import io.github.playcosmos.roulettebridge.db.BridgeDatabase;
import io.github.playcosmos.roulettebridge.issuance.TicketIssueEvent;
import io.github.playcosmos.roulettebridge.issuance.TicketNumberGenerator;
import io.github.playcosmos.roulettebridge.server.OverlayWebSocketServer;
import io.github.playcosmos.roulettebridge.storage.TicketArchiveService;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class AdminOperationsHandler implements HttpHandler {
    private static final Gson GSON = new Gson();
    private static final int MAX_JSON_BYTES = 64 * 1024;

    private final BridgeDatabase database;
    private final BridgeConfig.Ticket ticketConfig;
    private final DatabaseBackupService backup;
    private final TicketArchiveService archive;
    private final ManualAdjustmentService adjustment;
    private final OverlayWebSocketServer websocket;
    private final TicketNumberGenerator numberGenerator = new TicketNumberGenerator();

    public AdminOperationsHandler(
        BridgeDatabase database,
        BridgeConfig.Ticket ticketConfig,
        DatabaseBackupService backup,
        TicketArchiveService archive,
        ManualAdjustmentService adjustment,
        OverlayWebSocketServer websocket
    ) {
        this.database = database;
        this.ticketConfig = ticketConfig;
        this.backup = backup;
        this.archive = archive;
        this.adjustment = adjustment;
        this.websocket = websocket;
    }

    @Override
    public void handle(HttpExchange exchange) throws IOException {
        if (exchange.getRemoteAddress() == null
            || exchange.getRemoteAddress().getAddress() == null
            || !exchange.getRemoteAddress().getAddress().isLoopbackAddress()) {
            sendJson(exchange, 403, Map.of("error", "admin API is loopback-only"));
            return;
        }

        String base = "/api/admin";
        String path = exchange.getRequestURI().getPath();
        String route = path != null && path.startsWith(base) ? path.substring(base.length()) : "";

        try {
            if ("GET".equalsIgnoreCase(exchange.getRequestMethod()) && "/donors".equals(route)) {
                sendJson(exchange, 200, Map.of("donors", listDonors()));
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                exchange.sendResponseHeaders(405, -1);
                exchange.close();
                return;
            }

            switch (route) {
                case "/backup" -> {
                    Path result = backup.createBackup();
                    sendJson(exchange, 200, Map.of("path", result.toString()));
                }
                case "/manifests/rebuild" -> {
                    int count = archive.rebuildAllManifests();
                    sendJson(exchange, 200, Map.of("rebuilt", count));
                }
                case "/adjust" -> handleAdjustment(exchange);
                case "/test-ticket" -> handleTestTicket(exchange);
                default -> sendJson(exchange, 404, Map.of("error", "unknown admin route"));
            }
        } catch (IllegalArgumentException error) {
            sendJson(exchange, 400, Map.of("error", error.getMessage()));
        } catch (Exception error) {
            error.printStackTrace(System.err);
            sendJson(exchange, 500, Map.of("error", error.getMessage() == null ? error.getClass().getName() : error.getMessage()));
        }
    }

    private void handleAdjustment(HttpExchange exchange) throws Exception {
        JsonObject body = readJson(exchange);
        String donorId = string(body, "donorId", null);
        String nickname = string(body, "nickname", "익명");
        int delta = body.has("balloonDelta") ? body.get("balloonDelta").getAsInt() : 0;
        String reason = string(body, "reason", null);
        var result = adjustment.adjust(donorId, nickname, delta, reason);
        sendJson(exchange, 200, result);
    }

    private void handleTestTicket(HttpExchange exchange) throws Exception {
        JsonObject body = readJson(exchange);
        String nickname = string(body, "nickname", "테스트");
        var numbers = numberGenerator.generate(ticketConfig.numberMax(), ticketConfig.numberCount());
        String ticketId = "TEST-" + Instant.now().toEpochMilli() + "-" + shortUuid();
        var event = TicketIssueEvent.create(
            ticketId,
            "TEST",
            nickname,
            0,
            1,
            numbers,
            Instant.now().toString()
        );
        boolean delivered = websocket.broadcastTransient(GSON.toJson(event));
        sendJson(exchange, delivered ? 200 : 409, Map.of(
            "delivered", delivered,
            "ticket", event
        ));
    }

    private List<Map<String, Object>> listDonors() throws Exception {
        var donors = new ArrayList<Map<String, Object>>();
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 SELECT d.donor_id,
                        d.current_nickname,
                        d.total_balloons,
                        d.issued_ticket_count,
                        COUNT(t.ticket_id) AS allocated_ticket_count,
                        d.updated_at
                 FROM donor d
                 LEFT JOIN ticket t ON t.donor_id = d.donor_id
                 GROUP BY d.donor_id, d.current_nickname, d.total_balloons, d.issued_ticket_count, d.updated_at
                 ORDER BY d.updated_at DESC
                 LIMIT 500
                 """);
             var rows = statement.executeQuery()) {
            while (rows.next()) {
                var donor = new LinkedHashMap<String, Object>();
                donor.put("donorId", rows.getString("donor_id"));
                donor.put("nickname", rows.getString("current_nickname"));
                donor.put("totalBalloons", rows.getLong("total_balloons"));
                donor.put("issuedTickets", rows.getInt("issued_ticket_count"));
                donor.put("allocatedTickets", rows.getInt("allocated_ticket_count"));
                donor.put("remainderBalloons", rows.getLong("total_balloons") % ticketConfig.balloonsPerTicket());
                donor.put("updatedAt", rows.getString("updated_at"));
                donors.add(donor);
            }
        }
        return List.copyOf(donors);
    }

    private static JsonObject readJson(HttpExchange exchange) throws IOException {
        byte[] body = exchange.getRequestBody().readNBytes(MAX_JSON_BYTES + 1);
        if (body.length > MAX_JSON_BYTES) throw new IllegalArgumentException("request body exceeds 64 KiB");
        if (body.length == 0) return new JsonObject();
        var parsed = GSON.fromJson(new String(body, StandardCharsets.UTF_8), JsonObject.class);
        return parsed == null ? new JsonObject() : parsed;
    }

    private static String string(JsonObject object, String key, String fallback) {
        if (!object.has(key) || object.get(key).isJsonNull()) return fallback;
        String value = object.get(key).getAsString();
        return value == null || value.isBlank() ? fallback : value.trim();
    }

    private static String shortUuid() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 8);
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
}
