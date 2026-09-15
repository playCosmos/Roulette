package io.github.playcosmos.roulettebridge.soop;

import com.github.getcurrentthread.soopapi.event.model.BaseEvent;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * In-memory, bounded event stream for inspecting the currently connected SOOP channel.
 * The buffer is intentionally not persisted; this page is an operational live analyzer,
 * not an additional source of truth for donation or ticket data.
 */
public final class ChannelEventMonitor implements HttpHandler {
    private static final Gson GSON = new Gson();
    private static final int CAPACITY = 5_000;
    private static final int DEFAULT_LIMIT = 500;
    private static final int MAX_LIMIT = 1_000;

    private final Object lock = new Object();
    private final Deque<EventEntry> events = new ArrayDeque<>(CAPACITY);
    private final Map<String, Long> counts = new LinkedHashMap<>();
    private final String startedAt = OffsetDateTime.now().toString();
    private long nextSequence = 1L;
    private long totalCaptured;
    private long dropped;

    public void record(String streamerId, BaseEvent event) {
        if (event == null) return;

        var type = event.eventType();
        String typeName = type == null ? "UNKNOWN" : type.name();
        int code = type == null ? -1 : type.getCode();
        String description = type == null ? "Unknown" : type.getDescription();
        JsonElement payload;
        try {
            payload = GSON.toJsonTree(event);
        } catch (Exception error) {
            payload = GSON.toJsonTree(Map.of(
                "serializationError", error.getMessage() == null ? error.getClass().getName() : error.getMessage()
            ));
        }

        synchronized (lock) {
            long sequence = nextSequence++;
            totalCaptured++;
            counts.merge(typeName, 1L, Long::sum);
            events.addLast(new EventEntry(
                sequence,
                OffsetDateTime.now().toString(),
                streamerId == null ? "" : streamerId,
                code,
                typeName,
                description,
                event.getClass().getSimpleName(),
                event.timestamp(),
                event.raw(),
                payload
            ));
            while (events.size() > CAPACITY) {
                events.removeFirst();
                dropped++;
            }
        }
    }

    @Override
    public void handle(HttpExchange exchange) throws IOException {
        if (exchange.getRemoteAddress() == null
            || exchange.getRemoteAddress().getAddress() == null
            || !exchange.getRemoteAddress().getAddress().isLoopbackAddress()) {
            sendJson(exchange, 403, Map.of("error", "channel event API is loopback-only"));
            return;
        }

        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(405, -1);
            exchange.close();
            return;
        }

        String base = "/api/channel";
        String path = exchange.getRequestURI().getPath();
        String route = path != null && path.startsWith(base) ? path.substring(base.length()) : "";
        if (!"/events".equals(route)) {
            sendJson(exchange, 404, Map.of("error", "Not Found"));
            return;
        }

        Map<String, String> query = parseQuery(exchange.getRequestURI().getRawQuery());
        long after = parseLong(query.get("after"), 0L, 0L, Long.MAX_VALUE);
        int limit = (int) parseLong(query.get("limit"), DEFAULT_LIMIT, 1L, MAX_LIMIT);
        sendJson(exchange, 200, snapshot(after, limit));
    }

    private Map<String, Object> snapshot(long after, int limit) {
        synchronized (lock) {
            long earliest = events.isEmpty() ? nextSequence : events.getFirst().sequence();
            long latest = nextSequence - 1L;
            boolean truncated = after > 0L && after < earliest - 1L;

            var selected = new ArrayList<EventEntry>(Math.min(limit, events.size()));
            for (EventEntry event : events) {
                if (event.sequence() <= after) continue;
                selected.add(event);
                if (selected.size() >= limit) break;
            }

            var response = new LinkedHashMap<String, Object>();
            response.put("startedAt", startedAt);
            response.put("capacity", CAPACITY);
            response.put("buffered", events.size());
            response.put("totalCaptured", totalCaptured);
            response.put("dropped", dropped);
            response.put("earliestSequence", earliest);
            response.put("latestSequence", latest);
            response.put("truncated", truncated);
            response.put("counts", new LinkedHashMap<>(counts));
            response.put("events", selected);
            return response;
        }
    }

    private static Map<String, String> parseQuery(String rawQuery) {
        var result = new LinkedHashMap<String, String>();
        if (rawQuery == null || rawQuery.isBlank()) return result;
        for (String pair : rawQuery.split("&")) {
            int separator = pair.indexOf('=');
            String rawKey = separator >= 0 ? pair.substring(0, separator) : pair;
            String rawValue = separator >= 0 ? pair.substring(separator + 1) : "";
            result.put(
                URLDecoder.decode(rawKey, StandardCharsets.UTF_8),
                URLDecoder.decode(rawValue, StandardCharsets.UTF_8)
            );
        }
        return result;
    }

    private static long parseLong(String value, long fallback, long min, long max) {
        if (value == null || value.isBlank()) return fallback;
        try {
            long parsed = Long.parseLong(value);
            return Math.max(min, Math.min(max, parsed));
        } catch (NumberFormatException ignored) {
            return fallback;
        }
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

    public record EventEntry(
        long sequence,
        String receivedAt,
        String streamerId,
        int code,
        String type,
        String description,
        String eventClass,
        long sourceTimestamp,
        String raw,
        JsonElement payload
    ) {}
}
