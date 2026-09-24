package io.github.playcosmos.roulettebridge.room;

import com.google.gson.Gson;
import com.google.gson.JsonParseException;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.util.Map;
import java.util.NoSuchElementException;

import static io.github.playcosmos.roulettebridge.room.RoomModels.*;

public final class RoomHttpHandler implements HttpHandler {
    private static final Gson GSON = new Gson();
    private static final int MAX_REQUEST_BYTES = 1024 * 1024;
    private static final String BASE = "/api/board/rooms";

    private final RoomService rooms;
    private final BoardGameRuntimeEngine runtime;

    public RoomHttpHandler(RoomService rooms, BoardGameRuntimeEngine runtime) {
        this.rooms = rooms;
        this.runtime = runtime;
    }

    @Override
    public void handle(HttpExchange exchange) throws IOException {
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        exchange.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type");
        exchange.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

        if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
            return;
        }

        if (!isLoopback(exchange)) {
            sendJson(exchange, 403, error("board room API is loopback-only"));
            return;
        }

        String path = exchange.getRequestURI().getPath();
        String suffix = path != null && path.startsWith(BASE)
            ? path.substring(BASE.length())
            : "";

        try {
            if ((suffix.isEmpty() || "/".equals(suffix))
                && "POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                create(exchange);
                return;
            }

            if (!suffix.startsWith("/")) {
                sendJson(exchange, 404, error("Not Found"));
                return;
            }

            String route = suffix.substring(1);
            if (route.isBlank()) {
                sendJson(exchange, 404, error("Not Found"));
                return;
            }

            if (route.endsWith("/preview/reroll")) {
                if (!requireMethod(exchange, "POST")) return;
                String roomId = route.substring(0, route.length() - "/preview/reroll".length());
                sendJson(exchange, 200, rooms.rerollPreview(roomId));
                return;
            }

            if (route.endsWith("/preview/commit")) {
                if (!requireMethod(exchange, "POST")) return;
                String roomId = route.substring(0, route.length() - "/preview/commit".length());
                sendJson(exchange, 200, rooms.commitPreview(roomId));
                return;
            }

            if (route.endsWith("/runtime")) {
                if (!requireMethod(exchange, "GET")) return;
                String roomId = route.substring(0, route.length() - "/runtime".length());
                sendJson(exchange, 200, runtime.snapshot(roomId));
                return;
            }

            if (route.endsWith("/pause")) {
                if (!requireMethod(exchange, "POST")) return;
                String roomId = route.substring(0, route.length() - "/pause".length());
                var request = readOptionalPauseRequest(exchange);
                runtime.pauseRoom(
                    roomId,
                    request == null ? null : request.donationMode()
                );
                sendJson(exchange, 200, rooms.find(roomId));
                return;
            }

            if (route.endsWith("/resume")) {
                if (!requireMethod(exchange, "POST")) return;
                String roomId = route.substring(0, route.length() - "/resume".length());
                runtime.resumeRoom(roomId);
                sendJson(exchange, 200, rooms.find(roomId));
                return;
            }

            if (route.endsWith("/terminate")) {
                if (!requireMethod(exchange, "POST")) return;
                String roomId = route.substring(0, route.length() - "/terminate".length());
                runtime.terminateRoom(roomId);
                sendJson(exchange, 200, rooms.find(roomId));
                return;
            }

            if (route.contains("/")) {
                sendJson(exchange, 404, error("Not Found"));
                return;
            }

            if (!requireMethod(exchange, "GET")) return;
            sendJson(exchange, 200, rooms.find(route));
        } catch (RoomService.RoomValidationException error) {
            sendJson(exchange, 400, Map.of(
                "error", error.getMessage(),
                "details", error.errors()
            ));
        } catch (IllegalArgumentException error) {
            sendJson(exchange, 400, error(message(error)));
        } catch (IllegalStateException error) {
            sendJson(exchange, 409, error(message(error)));
        } catch (NoSuchElementException error) {
            sendJson(exchange, 404, error(message(error)));
        } catch (SQLException error) {
            error.printStackTrace(System.err);
            sendJson(exchange, 500, error("database operation failed"));
        }
    }

    private PauseRequest readOptionalPauseRequest(HttpExchange exchange) throws IOException {
        byte[] bytes = exchange.getRequestBody().readNBytes(16 * 1024 + 1);
        if (bytes.length > 16 * 1024) {
            throw new IllegalArgumentException("pause request exceeds 16 KiB");
        }
        if (bytes.length == 0) return null;

        String text = new String(bytes, StandardCharsets.UTF_8).trim();
        if (text.isEmpty()) return null;

        try {
            return GSON.fromJson(text, PauseRequest.class);
        } catch (JsonParseException error) {
            throw new IllegalArgumentException("invalid JSON body");
        }
    }

    private void create(HttpExchange exchange) throws IOException, SQLException {
        byte[] bytes = exchange.getRequestBody().readNBytes(MAX_REQUEST_BYTES + 1);
        if (bytes.length > MAX_REQUEST_BYTES) {
            sendJson(exchange, 413, error("room request exceeds 1 MiB"));
            return;
        }

        try {
            var request = GSON.fromJson(
                new String(bytes, StandardCharsets.UTF_8),
                CreateRoomRequest.class
            );
            sendJson(exchange, 201, rooms.create(request));
        } catch (JsonParseException error) {
            sendJson(exchange, 400, RoomModels.error("invalid JSON body"));
        }
    }

    private static boolean requireMethod(HttpExchange exchange, String method) throws IOException {
        if (method.equalsIgnoreCase(exchange.getRequestMethod())) return true;
        exchange.getResponseHeaders().set("Allow", method);
        exchange.sendResponseHeaders(405, -1);
        exchange.close();
        return false;
    }

    private static boolean isLoopback(HttpExchange exchange) {
        return exchange.getRemoteAddress() != null
            && exchange.getRemoteAddress().getAddress() != null
            && exchange.getRemoteAddress().getAddress().isLoopbackAddress();
    }

    private static String message(Throwable error) {
        String value = error.getMessage();
        return value == null || value.isBlank() ? error.getClass().getSimpleName() : value;
    }

    private record PauseRequest(String donationMode) {}

    private static void sendJson(HttpExchange exchange, int status, Object payload) throws IOException {
        byte[] body = GSON.toJson(payload).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, body.length);
        try (var output = exchange.getResponseBody()) {
            output.write(body);
        }
    }
}
