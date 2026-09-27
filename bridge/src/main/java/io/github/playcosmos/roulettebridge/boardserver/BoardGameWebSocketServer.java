package io.github.playcosmos.roulettebridge.boardserver;

import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Predicate;
import java.util.regex.Pattern;
import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;

public final class BoardGameWebSocketServer extends WebSocketServer {
    private static final Pattern ROOM_CODE_PATTERN =
        Pattern.compile("[A-HJ-NP-Z2-9]{6}");

    private final AtomicInteger connectedClients = new AtomicInteger();
    private final Map<WebSocket, String> roomByConnection =
        new ConcurrentHashMap<>();
    private final Predicate<String> roomCodeValidator;

    public BoardGameWebSocketServer(String host, int port) {
        this(host, port, roomCode -> true);
    }

    public BoardGameWebSocketServer(
        String host,
        int port,
        Predicate<String> roomCodeValidator
    ) {
        super(new InetSocketAddress(host, port));
        this.roomCodeValidator = roomCodeValidator == null
            ? roomCode -> false
            : roomCodeValidator;
        setReuseAddr(true);
    }

    @Override
    public void onOpen(WebSocket connection, ClientHandshake handshake) {
        String roomCode = roomCode(handshake);
        if (
            roomCode == null
            || !roomCodeValidator.test(roomCode)
        ) {
            connection.close(1008, "valid committed room code required");
            return;
        }

        roomByConnection.put(connection, roomCode);
        int count = connectedClients.incrementAndGet();
        System.out.println(
            "[board-ws] connected room=" + roomCode + ": "
                + connection.getRemoteSocketAddress()
                + " (" + count + ")"
        );
    }

    @Override
    public void onClose(
        WebSocket connection,
        int code,
        String reason,
        boolean remote
    ) {
        String roomCode = roomByConnection.remove(connection);
        int count = connectedClients.get();
        if (roomCode != null) {
            count = Math.max(0, connectedClients.decrementAndGet());
        }
        System.out.println(
            "[board-ws] disconnected"
                + (roomCode == null ? "" : " room=" + roomCode)
                + " (" + count + ")"
        );
    }

    @Override
    public void onMessage(WebSocket connection, String message) {
        if ("ping".equalsIgnoreCase(message.trim())) {
            connection.send("pong");
        }
    }

    @Override
    public void onError(WebSocket connection, Exception error) {
        System.err.println("[board-ws] " + error.getMessage());
    }

    @Override
    public void onStart() {
        System.out.println(
            "[board-ws] listening on ws://"
                + getAddress().getHostString()
                + ":" + getPort()
        );
    }

    public int connectedClients() {
        return connectedClients.get();
    }

    public boolean broadcastEvent(String roomId, String json) {
        String normalizedRoomId = normalizeRoomCode(roomId);
        if (normalizedRoomId == null) return false;

        boolean sent = false;
        for (var entry : roomByConnection.entrySet()) {
            if (!normalizedRoomId.equals(entry.getValue())) continue;
            WebSocket connection = entry.getKey();
            if (!connection.isOpen()) continue;
            connection.send(json);
            sent = true;
        }
        return sent;
    }

    @Deprecated
    public boolean broadcastEvent(String json) {
        boolean sent = false;
        for (WebSocket connection : roomByConnection.keySet()) {
            if (!connection.isOpen()) continue;
            connection.send(json);
            sent = true;
        }
        return sent;
    }

    private static String roomCode(ClientHandshake handshake) {
        if (handshake == null) return null;

        String resource = handshake.getResourceDescriptor();
        if (resource == null) return null;

        int queryIndex = resource.indexOf('?');
        if (queryIndex < 0 || queryIndex >= resource.length() - 1) {
            return null;
        }

        String query = resource.substring(queryIndex + 1);
        for (String pair : query.split("&")) {
            int equals = pair.indexOf('=');
            if (equals <= 0) continue;

            String name = URLDecoder.decode(
                pair.substring(0, equals),
                StandardCharsets.UTF_8
            );
            if (!"roomCode".equals(name)) continue;

            String value = URLDecoder.decode(
                pair.substring(equals + 1),
                StandardCharsets.UTF_8
            );
            return normalizeRoomCode(value);
        }

        return null;
    }

    private static String normalizeRoomCode(String value) {
        if (value == null) return null;
        String normalized = value.trim().toUpperCase(Locale.ROOT);
        return ROOM_CODE_PATTERN.matcher(normalized).matches()
            ? normalized
            : null;
    }
}
