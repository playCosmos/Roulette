package io.github.playcosmos.roulettebridge.operations;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import io.github.playcosmos.roulettebridge.config.BridgeConfig;
import io.github.playcosmos.roulettebridge.config.ConfigLoader;
import io.github.playcosmos.roulettebridge.db.BridgeDatabase;
import io.github.playcosmos.roulettebridge.issuance.TicketIssueEvent;
import io.github.playcosmos.roulettebridge.issuance.TicketNumberGenerator;
import io.github.playcosmos.roulettebridge.server.OverlayWebSocketServer;
import io.github.playcosmos.roulettebridge.storage.TicketArchiveService;
import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Consumer;

public final class AdminOperationsHandler implements HttpHandler {
    private static final Gson GSON = new Gson();
    private static final int MAX_JSON_BYTES = 64 * 1024;

    private final BridgeDatabase database;
    private final BridgeConfig startupConfig;
    private final BridgeConfig.Ticket ticketConfig;
    private final Path configPath;
    private final Consumer<BridgeConfig> liveConfigConsumer;
    private final DatabaseBackupService backup;
    private final TicketArchiveService archive;
    private final ManualAdjustmentService adjustment;
    private final OverlayWebSocketServer websocket;
    private final RestartService restartService;
    private final SoopUserLookupService directLookup;
    private final TicketNumberGenerator numberGenerator = new TicketNumberGenerator();

    public AdminOperationsHandler(
        BridgeDatabase database,
        BridgeConfig startupConfig,
        Path configPath,
        Consumer<BridgeConfig> liveConfigConsumer,
        DatabaseBackupService backup,
        TicketArchiveService archive,
        ManualAdjustmentService adjustment,
        OverlayWebSocketServer websocket,
        RestartService restartService,
        SoopUserLookupService directLookup
    ) {
        this.database = Objects.requireNonNull(database, "database");
        this.startupConfig = Objects.requireNonNull(startupConfig, "startupConfig").normalized();
        this.ticketConfig = this.startupConfig.ticket();
        this.configPath = Objects.requireNonNull(configPath, "configPath").toAbsolutePath().normalize();
        this.liveConfigConsumer = Objects.requireNonNull(liveConfigConsumer, "liveConfigConsumer");
        this.backup = Objects.requireNonNull(backup, "backup");
        this.archive = Objects.requireNonNull(archive, "archive");
        this.adjustment = Objects.requireNonNull(adjustment, "adjustment");
        this.websocket = Objects.requireNonNull(websocket, "websocket");
        this.restartService = Objects.requireNonNull(restartService, "restartService");
        this.directLookup = Objects.requireNonNull(directLookup, "directLookup");
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
        String method = exchange.getRequestMethod();

        try {
            if ("GET".equalsIgnoreCase(method) && "/donors".equals(route)) {
                sendJson(exchange, 200, Map.of("donors", listDonors()));
                return;
            }
            if ("GET".equalsIgnoreCase(method) && "/donor-resolve".equals(route)) {
                handleLocalDonorResolve(exchange);
                return;
            }
            if ("GET".equalsIgnoreCase(method) && "/donor-lookup".equals(route)) {
                handleDirectDonorLookup(exchange);
                return;
            }
            if ("GET".equalsIgnoreCase(method) && "/config".equals(route)) {
                handleConfigGet(exchange);
                return;
            }
            if ("PUT".equalsIgnoreCase(method) && "/config".equals(route)) {
                handleConfigSave(exchange);
                return;
            }
            if (!"POST".equalsIgnoreCase(method)) {
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

    private void handleConfigGet(HttpExchange exchange) throws Exception {
        BridgeConfig config = ConfigLoader.load(configPath);
        List<String> restartFields = restartFields(config);
        sendJson(exchange, 200, Map.of(
            "config", config,
            "configPath", configPath.toString(),
            "requiresRestart", !restartFields.isEmpty(),
            "restartFields", restartFields
        ));
    }

    private void handleConfigSave(HttpExchange exchange) throws Exception {
        BridgeConfig before = ConfigLoader.load(configPath);
        BridgeConfig requested = readConfig(exchange);
        BridgeConfig saved = ConfigLoader.save(configPath, requested);
        List<String> restartFields = restartFields(saved);

        boolean liveChanged = !Objects.equals(before.streamerId(), saved.streamerId())
            || !Objects.equals(before.soop(), saved.soop());
        boolean liveApplied = false;
        RestartService.RestartResult restart = null;

        if (restartFields.isEmpty()) {
            if (liveChanged) {
                liveConfigConsumer.accept(saved);
                liveApplied = true;
            }
        } else {
            restart = restartService.schedule();
            if (restart.scheduled()) {
                String control = GSON.toJson(Map.of(
                    "type", "bridge.restart",
                    "websocketUrl", websocketUrl(saved),
                    "apiBase", adminOrigin(saved),
                    "adminUrl", adminUrl(saved),
                    "overlayUrl", overlayUrl(saved)
                ));
                websocket.broadcastTransient(control);
            } else if (liveChanged) {
                liveConfigConsumer.accept(saved);
                liveApplied = true;
            }
        }

        var payload = new LinkedHashMap<String, Object>();
        payload.put("saved", true);
        payload.put("config", saved);
        payload.put("liveApplied", liveApplied);
        payload.put("requiresRestart", !restartFields.isEmpty());
        payload.put("restartFields", restartFields);
        payload.put("restartScheduled", restart != null && restart.scheduled());
        payload.put("restartMessage", restart == null ? "" : restart.message());
        payload.put("nextAdminUrl", adminUrl(saved));
        payload.put("nextOverlayUrl", overlayUrl(saved));
        payload.put("nextWebsocketUrl", websocketUrl(saved));
        sendJson(exchange, 200, payload);
    }

    private List<String> restartFields(BridgeConfig config) {
        var fields = new ArrayList<String>();
        if (!Objects.equals(startupConfig.ticket(), config.ticket())) fields.add("ticket");
        if (!Objects.equals(startupConfig.server(), config.server())) fields.add("server");
        if (!Objects.equals(startupConfig.storage(), config.storage())) fields.add("storage");
        return List.copyOf(fields);
    }

    private void handleLocalDonorResolve(HttpExchange exchange) throws Exception {
        String value = query(exchange, "value");
        String field = normalizeField(query(exchange, "field"));
        if (value == null || value.isBlank()) throw new IllegalArgumentException("value is required");
        var candidates = findLocalDonors(value.trim(), field);
        sendJson(exchange, 200, Map.of(
            "source", "local",
            "query", value.trim(),
            "field", field,
            "resolved", candidates.size() == 1,
            "match", candidates.size() == 1 ? candidates.getFirst() : Map.of(),
            "candidates", candidates
        ));
    }

    private void handleDirectDonorLookup(HttpExchange exchange) throws Exception {
        String value = query(exchange, "value");
        String field = normalizeField(query(exchange, "field"));
        if (value == null || value.isBlank()) throw new IllegalArgumentException("value is required");
        sendJson(exchange, 200, directLookup.lookup(value, field));
    }

    private void handleAdjustment(HttpExchange exchange) throws Exception {
        JsonObject body = readJson(exchange);
        String donorId = string(body, "donorId", null);
        String nickname = string(body, "nickname", null);
        int delta = body.has("balloonDelta") ? body.get("balloonDelta").getAsInt() : 0;
        String reason = string(body, "reason", null);

        if ((donorId == null || donorId.isBlank()) && (nickname == null || nickname.isBlank())) {
            throw new IllegalArgumentException("SOOP 사용자 ID 또는 닉네임 중 하나 이상을 입력하세요.");
        }
        if (donorId == null || donorId.isBlank()) {
            var matches = findLocalDonors(nickname, "nickname");
            if (matches.size() != 1) {
                throw new IllegalArgumentException("닉네임만으로 사용자를 확정할 수 없습니다. 자동 조회 결과를 확인하세요.");
            }
            donorId = String.valueOf(matches.getFirst().get("donorId"));
        }
        if (nickname == null || nickname.isBlank()) {
            var matches = findLocalDonors(donorId, "id");
            if (matches.size() != 1) {
                throw new IllegalArgumentException("ID만으로 사용자를 확정할 수 없습니다. 자동 조회 결과를 확인하세요.");
            }
            nickname = String.valueOf(matches.getFirst().get("nickname"));
        }

        var result = adjustment.adjust(donorId, nickname, delta, reason);
        sendJson(exchange, 200, result);
    }

    private void handleTestTicket(HttpExchange exchange) throws Exception {
        if (websocket.connectedClients() <= 0) {
            sendJson(exchange, 409, Map.of(
                "error", "OBS 또는 방송용 오버레이가 연결되어 있지 않습니다.",
                "overlayClients", 0
            ));
            return;
        }

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
        if (!delivered) {
            sendJson(exchange, 409, Map.of(
                "error", "테스트 티켓 전송 직전에 오버레이 연결이 끊어졌습니다.",
                "overlayClients", websocket.connectedClients()
            ));
            return;
        }
        sendJson(exchange, 200, Map.of(
            "delivered", true,
            "overlayClients", websocket.connectedClients(),
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
                long totalBalloons = rows.getLong("total_balloons");
                int allocatedTickets = rows.getInt("allocated_ticket_count");
                long remainderBalloons = ticketConfig.singleDonationMode()
                    ? Math.max(0L, totalBalloons - (long) allocatedTickets * ticketConfig.balloonsPerTicket())
                    : totalBalloons % ticketConfig.balloonsPerTicket();

                var donor = new LinkedHashMap<String, Object>();
                donor.put("donorId", rows.getString("donor_id"));
                donor.put("nickname", rows.getString("current_nickname"));
                donor.put("totalBalloons", totalBalloons);
                donor.put("issuedTickets", rows.getInt("issued_ticket_count"));
                donor.put("allocatedTickets", allocatedTickets);
                donor.put("remainderBalloons", remainderBalloons);
                donor.put("updatedAt", rows.getString("updated_at"));
                donors.add(donor);
            }
        }
        return List.copyOf(donors);
    }

    private List<Map<String, Object>> findLocalDonors(String value, String field) throws Exception {
        String sql = switch (field) {
            case "id" -> """
                SELECT donor_id, current_nickname, total_balloons, issued_ticket_count, updated_at
                FROM donor WHERE donor_id = ? COLLATE NOCASE LIMIT 10
                """;
            case "nickname" -> """
                SELECT donor_id, current_nickname, total_balloons, issued_ticket_count, updated_at
                FROM donor WHERE current_nickname = ? LIMIT 10
                """;
            default -> """
                SELECT donor_id, current_nickname, total_balloons, issued_ticket_count, updated_at
                FROM donor
                WHERE donor_id = ? COLLATE NOCASE OR current_nickname = ?
                ORDER BY CASE WHEN donor_id = ? COLLATE NOCASE THEN 0 ELSE 1 END, updated_at DESC
                LIMIT 10
                """;
        };
        var result = new ArrayList<Map<String, Object>>();
        try (var connection = database.open(); var statement = connection.prepareStatement(sql)) {
            statement.setString(1, value);
            if ("auto".equals(field)) {
                statement.setString(2, value);
                statement.setString(3, value);
            }
            try (var rows = statement.executeQuery()) {
                while (rows.next()) {
                    var item = new LinkedHashMap<String, Object>();
                    item.put("donorId", rows.getString("donor_id"));
                    item.put("nickname", rows.getString("current_nickname"));
                    item.put("totalBalloons", rows.getLong("total_balloons"));
                    item.put("issuedTickets", rows.getInt("issued_ticket_count"));
                    item.put("updatedAt", rows.getString("updated_at"));
                    result.add(item);
                }
            }
        }
        return List.copyOf(result);
    }

    private static String normalizeField(String field) {
        if (field == null || field.isBlank()) return "auto";
        return switch (field.trim().toLowerCase(Locale.ROOT)) {
            case "id", "donorid", "user_id" -> "id";
            case "nickname", "nick", "user_nick" -> "nickname";
            default -> "auto";
        };
    }

    private static String query(HttpExchange exchange, String key) {
        String raw = exchange.getRequestURI().getRawQuery();
        if (raw == null || raw.isBlank()) return null;
        for (String pair : raw.split("&")) {
            int split = pair.indexOf('=');
            String name = split >= 0 ? pair.substring(0, split) : pair;
            if (!URLDecoder.decode(name, StandardCharsets.UTF_8).equals(key)) continue;
            String value = split >= 0 ? pair.substring(split + 1) : "";
            return URLDecoder.decode(value, StandardCharsets.UTF_8);
        }
        return null;
    }

    private static String adminOrigin(BridgeConfig config) {
        return "http://127.0.0.1:" + config.server().port();
    }

    private static String adminUrl(BridgeConfig config) {
        return adminOrigin(config) + "/soop-admin.html?restarted=1";
    }

    private static String websocketUrl(BridgeConfig config) {
        return "ws://127.0.0.1:" + config.server().websocketPort();
    }

    private static String overlayUrl(BridgeConfig config) {
        return adminOrigin(config) + "/soop-overlay.html?ws=" + websocketUrl(config);
    }

    private static BridgeConfig readConfig(HttpExchange exchange) throws IOException {
        byte[] body = readBody(exchange);
        if (body.length == 0) throw new IllegalArgumentException("config body is required");
        var parsed = GSON.fromJson(new String(body, StandardCharsets.UTF_8), BridgeConfig.class);
        if (parsed == null) throw new IllegalArgumentException("invalid config body");
        return parsed.normalized();
    }

    private static JsonObject readJson(HttpExchange exchange) throws IOException {
        byte[] body = readBody(exchange);
        if (body.length == 0) return new JsonObject();
        var parsed = GSON.fromJson(new String(body, StandardCharsets.UTF_8), JsonObject.class);
        return parsed == null ? new JsonObject() : parsed;
    }

    private static byte[] readBody(HttpExchange exchange) throws IOException {
        byte[] body = exchange.getRequestBody().readNBytes(MAX_JSON_BYTES + 1);
        if (body.length > MAX_JSON_BYTES) throw new IllegalArgumentException("request body exceeds 64 KiB");
        return body;
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
