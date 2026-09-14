package io.github.playcosmos.roulettebridge.server;

import java.net.InetSocketAddress;
import java.util.concurrent.atomic.AtomicInteger;
import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;

public final class OverlayWebSocketServer extends WebSocketServer {
    private final AtomicInteger connectedClients = new AtomicInteger();

    public OverlayWebSocketServer(String host, int port) {
        super(new InetSocketAddress(host, port));
        setReuseAddr(true);
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        int count = connectedClients.incrementAndGet();
        System.out.println("[ws] overlay connected: " + conn.getRemoteSocketAddress() + " (" + count + ")");
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        int count = Math.max(0, connectedClients.decrementAndGet());
        System.out.println("[ws] overlay disconnected (" + count + ")");
    }

    @Override
    public void onMessage(WebSocket conn, String message) {
        if ("ping".equalsIgnoreCase(message.trim())) conn.send("pong");
    }

    @Override
    public void onError(WebSocket conn, Exception error) {
        System.err.println("[ws] " + error.getMessage());
    }

    @Override
    public void onStart() {
        System.out.println("[ws] listening on ws://" + getAddress().getHostString() + ":" + getPort());
    }

    public int connectedClients() {
        return connectedClients.get();
    }

    public void broadcastTicketEvent(String json) {
        broadcast(json);
    }
}
