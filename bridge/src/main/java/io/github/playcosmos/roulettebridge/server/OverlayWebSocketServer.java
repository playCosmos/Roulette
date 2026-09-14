package io.github.playcosmos.roulettebridge.server;

import java.net.InetSocketAddress;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import java.util.function.Supplier;
import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;

public final class OverlayWebSocketServer extends WebSocketServer {
    private final AtomicInteger connectedClients = new AtomicInteger();
    private volatile Supplier<List<ReplayMessage>> replaySupplier = List::of;
    private volatile Consumer<String> dispatchedCallback = ticketId -> {};

    public OverlayWebSocketServer(String host, int port) {
        super(new InetSocketAddress(host, port));
        setReuseAddr(true);
    }

    public void configureRecovery(
        Supplier<List<ReplayMessage>> replaySupplier,
        Consumer<String> dispatchedCallback
    ) {
        this.replaySupplier = replaySupplier == null ? List::of : replaySupplier;
        this.dispatchedCallback = dispatchedCallback == null ? ticketId -> {} : dispatchedCallback;
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        int count = connectedClients.incrementAndGet();
        System.out.println("[ws] overlay connected: " + conn.getRemoteSocketAddress() + " (" + count + ")");
        replayPending(conn);
    }

    private void replayPending(WebSocket conn) {
        try {
            var pending = replaySupplier.get();
            if (pending.isEmpty()) return;
            System.out.println("[recovery] replaying " + pending.size() + " ticket(s) to overlay");
            for (var message : pending) {
                conn.send(message.json());
                dispatchedCallback.accept(message.ticketId());
            }
        } catch (Exception error) {
            System.err.println("[recovery] overlay replay failed: " + error.getMessage());
            error.printStackTrace(System.err);
        }
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

    public boolean dispatchTicketEvent(String ticketId, String json) {
        if (connectedClients.get() <= 0) {
            System.out.println("[ws] no overlay client; ticket remains pending: " + ticketId);
            return false;
        }
        broadcast(json);
        dispatchedCallback.accept(ticketId);
        return true;
    }

    public boolean broadcastTransient(String json) {
        if (connectedClients.get() <= 0) return false;
        broadcast(json);
        return true;
    }

    public record ReplayMessage(String ticketId, String json) {}
}
