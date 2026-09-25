package io.github.playcosmos.roulettebridge.boardserver;

import java.net.InetSocketAddress;
import java.util.concurrent.atomic.AtomicInteger;
import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;

public final class BoardGameWebSocketServer extends WebSocketServer {
    private final AtomicInteger connectedClients = new AtomicInteger();

    public BoardGameWebSocketServer(String host, int port) {
        super(new InetSocketAddress(host, port));
        setReuseAddr(true);
    }

    @Override
    public void onOpen(WebSocket connection, ClientHandshake handshake) {
        int count = connectedClients.incrementAndGet();
        System.out.println("[board-ws] connected: " + connection.getRemoteSocketAddress() + " (" + count + ")");
    }

    @Override
    public void onClose(WebSocket connection, int code, String reason, boolean remote) {
        int count = Math.max(0, connectedClients.decrementAndGet());
        System.out.println("[board-ws] disconnected (" + count + ")");
    }

    @Override
    public void onMessage(WebSocket connection, String message) {
        if ("ping".equalsIgnoreCase(message.trim())) connection.send("pong");
    }

    @Override
    public void onError(WebSocket connection, Exception error) {
        System.err.println("[board-ws] " + error.getMessage());
    }

    @Override
    public void onStart() {
        System.out.println("[board-ws] listening on ws://" + getAddress().getHostString() + ":" + getPort());
    }

    public int connectedClients() {
        return connectedClients.get();
    }

    public boolean broadcastEvent(String json) {
        if (connectedClients.get() <= 0) return false;
        broadcast(json);
        return true;
    }
}
