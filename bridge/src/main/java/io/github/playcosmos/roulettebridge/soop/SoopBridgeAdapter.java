package io.github.playcosmos.roulettebridge.soop;

import com.github.getcurrentthread.soopapi.SOOPClient;
import com.github.getcurrentthread.soopapi.event.ChatEvent;
import com.github.getcurrentthread.soopapi.event.model.DisconnectedEvent;
import com.github.getcurrentthread.soopapi.event.model.JoinChannelEvent;
import com.github.getcurrentthread.soopapi.event.model.ReconnectedEvent;
import com.github.getcurrentthread.soopapi.event.model.ReconnectingEvent;
import com.github.getcurrentthread.soopapi.event.model.SendBalloonEvent;
import io.github.playcosmos.roulettebridge.config.BridgeConfig;
import java.time.Duration;
import java.util.Objects;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

public final class SoopBridgeAdapter implements AutoCloseable {
    private static final long JOIN_TIMEOUT_SECONDS = 30;

    private volatile BridgeConfig config;
    private final SoopRuntimeState state;
    private final Consumer<SoopDonation> donationSink;
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(
        Thread.ofVirtual().name("soop-supervisor-", 0).factory()
    );
    private final AtomicBoolean closed = new AtomicBoolean(false);
    private final AtomicBoolean probeScheduled = new AtomicBoolean(false);
    private final AtomicBoolean forcedReconnectInFlight = new AtomicBoolean(false);
    private final AtomicLong generation = new AtomicLong(0);
    private final AtomicLong connectionAttempt = new AtomicLong(0);
    private volatile SOOPClient client;

    public SoopBridgeAdapter(
        BridgeConfig config,
        SoopRuntimeState state,
        Consumer<SoopDonation> donationSink
    ) {
        this.config = Objects.requireNonNull(config, "config").normalized();
        this.state = Objects.requireNonNull(state, "state");
        this.donationSink = Objects.requireNonNull(donationSink, "donationSink");
    }

    public void start() {
        var current = config;
        if (!current.soop().enabled()) {
            state.status("DISABLED");
            System.out.println("[soop] disabled by config");
            return;
        }
        if (!hasStreamerId(current)) {
            state.status("WAITING_FOR_STREAMER_ID");
            System.out.println("[soop] streamerId is not configured");
            return;
        }
        scheduleProbe(0);
    }

    public void applyConfig(BridgeConfig newConfig) {
        if (closed.get()) return;
        var normalized = Objects.requireNonNull(newConfig, "newConfig").normalized();
        config = normalized;
        state.streamerId(normalized.streamerId());
        scheduler.execute(() -> {
            if (closed.get()) return;
            forcedReconnectInFlight.set(false);
            generation.incrementAndGet();
            connectionAttempt.incrementAndGet();
            closeClient();
            if (!normalized.soop().enabled()) {
                state.status("DISABLED");
                System.out.println("[soop] disabled by updated config");
                return;
            }
            if (!hasStreamerId(normalized)) {
                state.status("WAITING_FOR_STREAMER_ID");
                System.out.println("[soop] waiting for streamerId after config update");
                return;
            }
            state.status("IDLE");
            System.out.println("[soop] applying updated connection config");
            probeAndConnect();
        });
    }

    public void reconnectNow() {
        if (closed.get()) return;
        var currentConfig = config;
        if (!currentConfig.soop().enabled()) {
            state.status("DISABLED");
            return;
        }
        if (!hasStreamerId(currentConfig)) {
            state.status("WAITING_FOR_STREAMER_ID");
            return;
        }

        scheduler.execute(() -> {
            if (closed.get()) return;

            var activeConfig = config;
            String streamerId = activeConfig.streamerId();
            var currentClient = client;
            long currentGeneration = generation.get();

            if (currentClient != null
                && currentClient.get(streamerId) != null
                && isCurrent(currentGeneration)) {
                long attempt = connectionAttempt.incrementAndGet();
                forcedReconnectInFlight.set(true);
                state.clearError();
                state.status("RECONNECTING");
                System.out.println("[soop] manual force reconnect requested");

                try {
                    currentClient.reconnect(streamerId).whenComplete((ignored, error) -> {
                        if (error == null) return;
                        scheduler.execute(() -> {
                            if (!isCurrentAttempt(currentGeneration, attempt)) return;
                            forcedReconnectInFlight.set(false);
                            state.status("CONNECTION_FAILED");
                            state.error(unwrap(error));
                            System.err.println("[soop] manual reconnect failed: " + describe(error));
                            scheduleProbe(config.soop().offlinePollSeconds());
                        });
                    });
                    scheduleConnectionTimeout(currentGeneration, attempt);
                } catch (Exception reconnectError) {
                    if (!isCurrentAttempt(currentGeneration, attempt)) return;
                    forcedReconnectInFlight.set(false);
                    state.status("CONNECTION_FAILED");
                    state.error(reconnectError);
                    System.err.println("[soop] manual reconnect failed: " + describe(reconnectError));
                    scheduleProbe(config.soop().offlinePollSeconds());
                }
                return;
            }

            forcedReconnectInFlight.set(false);
            state.status("IDLE");
            System.out.println("[soop] reconnect requested without reusable chat client; starting fresh probe");
            probeAndConnect();
        });
    }

    private static boolean hasStreamerId(BridgeConfig value) {
        return value.streamerId() != null
            && !value.streamerId().isBlank()
            && !"STREAMER_ID".equals(value.streamerId());
    }

    private void scheduleProbe(long delaySeconds) {
        if (closed.get() || !probeScheduled.compareAndSet(false, true)) return;
        scheduler.schedule(() -> {
            probeScheduled.set(false);
            if (closed.get()) return;
            String currentStatus = state.status();
            if ("CONNECTED".equals(currentStatus)
                || "CONNECTING".equals(currentStatus)
                || "RECONNECTING".equals(currentStatus)
                || "PROBING".equals(currentStatus)) {
                return;
            }
            probeAndConnect();
        }, Math.max(0, delaySeconds), TimeUnit.SECONDS);
    }

    private void probeAndConnect() {
        if (closed.get()) return;

        var activeConfig = config;
        if (!activeConfig.soop().enabled()) {
            state.status("DISABLED");
            return;
        }
        if (!hasStreamerId(activeConfig)) {
            state.status("WAITING_FOR_STREAMER_ID");
            return;
        }

        forcedReconnectInFlight.set(false);
        String streamerId = activeConfig.streamerId();
        long currentGeneration = generation.incrementAndGet();
        long attempt = connectionAttempt.incrementAndGet();
        closeClient();

        var nextClient = new SOOPClient();
        client = nextClient;
        attachListeners(nextClient, currentGeneration);
        state.status("PROBING");

        nextClient.live().detail(streamerId).whenComplete((detail, error) -> {
            if (!isCurrentAttempt(currentGeneration, attempt)) return;
            if (error != null) {
                state.status("OFFLINE_OR_UNAVAILABLE");
                state.error(unwrap(error));
                System.err.println("[soop] live probe failed: " + describe(error));
                generation.incrementAndGet();
                connectionAttempt.incrementAndGet();
                closeClient();
                scheduleProbe(config.soop().offlinePollSeconds());
                return;
            }

            state.live(detail.bno(), detail.title());
            state.status("CONNECTING");
            System.out.println("[soop] live found: bno=" + detail.bno() + " title=" + detail.title());

            try {
                // SOOPClient.add() starts the asynchronous chat connection itself.
                nextClient.add(streamerId);
                scheduleConnectionTimeout(currentGeneration, attempt);
            } catch (Exception connectError) {
                if (!isCurrentAttempt(currentGeneration, attempt)) return;
                state.status("CONNECTION_FAILED");
                state.error(connectError);
                System.err.println("[soop] chat connection failed: " + describe(connectError));
                generation.incrementAndGet();
                connectionAttempt.incrementAndGet();
                closeClient();
                scheduleProbe(config.soop().offlinePollSeconds());
            }
        });
    }

    private void scheduleConnectionTimeout(long expectedGeneration, long expectedAttempt) {
        scheduler.schedule(() -> {
            if (!isCurrentAttempt(expectedGeneration, expectedAttempt)) return;
            String status = state.status();
            if (!"CONNECTING".equals(status) && !"RECONNECTING".equals(status)) return;

            var timeout = new TimeoutException(
                "chat connection timeout after " + JOIN_TIMEOUT_SECONDS + " seconds"
            );
            forcedReconnectInFlight.set(false);
            state.status("CONNECTION_FAILED");
            state.error(timeout);
            System.err.println("[soop] " + timeout.getMessage());

            // Keep the registered SOOP client so a later manual reconnect can call
            // forceReconnect(), which tears down an in-flight/backoff connection even
            // when SOOPChatClient.isConnected() is false.
            scheduleProbe(config.soop().offlinePollSeconds());
        }, JOIN_TIMEOUT_SECONDS, TimeUnit.SECONDS);
    }

    private void attachListeners(SOOPClient soop, long listenerGeneration) {
        soop.on(ChatEvent.JOIN_CHANNEL, (String bid, JoinChannelEvent event) -> {
            if (!isCurrent(listenerGeneration)) return;
            forcedReconnectInFlight.set(false);
            state.clearError();
            state.status("CONNECTED");
            System.out.println("[soop] joined chat: " + bid);
        });

        soop.on(ChatEvent.SEND_BALLOON, (String bid, SendBalloonEvent event) -> {
            if (!isCurrent(listenerGeneration)) return;
            if (event.count() <= 0 || event.senderId() == null || event.senderId().isBlank()) return;
            state.donationReceived();
            var donation = new SoopDonation(
                bid,
                event.senderId(),
                event.senderNickname(),
                event.count(),
                event.fanOrder(),
                event.raw(),
                event.timestamp()
            );
            System.out.println("[soop] balloon: " + donation.nickname() + " (" + donation.donorId() + ") x" + donation.balloonCount());
            donationSink.accept(donation);
        });

        soop.on(ChatEvent.RECONNECTING, (String bid, ReconnectingEvent event) -> {
            if (!isCurrent(listenerGeneration)) return;
            state.status("RECONNECTING");
            System.out.println("[soop] reconnecting " + event.attemptNumber() + "/" + event.maxAttempts());
        });

        soop.on(ChatEvent.RECONNECTED, (String bid, ReconnectedEvent event) -> {
            if (!isCurrent(listenerGeneration)) return;
            forcedReconnectInFlight.set(false);
            state.clearError();
            state.status("CONNECTED");
            System.out.println("[soop] reconnected: " + bid);
        });

        soop.on(ChatEvent.DISCONNECTED, (String bid, DisconnectedEvent event) -> {
            if (!isCurrent(listenerGeneration)) return;

            // forceReconnect() intentionally tears the current connection down before
            // starting the replacement connection. Do not treat that expected teardown
            // as a fresh outage or queue another probe while the forced reconnect is active.
            if (forcedReconnectInFlight.get()) {
                state.status("RECONNECTING");
                System.out.println("[soop] expected disconnect during forced reconnect: " + event.reason());
                return;
            }

            state.status(event.causedByError() ? "DISCONNECTED_ERROR" : "DISCONNECTED");
            if (event.causedByError()) state.error(new IllegalStateException(event.reason()));
            System.out.println("[soop] disconnected: code=" + event.statusCode() + " reason=" + event.reason());
            scheduleProbe(config.soop().offlinePollSeconds());
        });
    }

    private boolean isCurrent(long expectedGeneration) {
        return !closed.get() && generation.get() == expectedGeneration;
    }

    private boolean isCurrentAttempt(long expectedGeneration, long expectedAttempt) {
        return isCurrent(expectedGeneration) && connectionAttempt.get() == expectedAttempt;
    }

    private void closeClient() {
        var current = client;
        client = null;
        if (current != null) {
            try {
                current.close();
            } catch (Exception error) {
                System.err.println("[soop] close error: " + error.getMessage());
            }
        }
    }

    private static Throwable unwrap(Throwable error) {
        Throwable current = error;
        while ((current instanceof java.util.concurrent.CompletionException
            || current instanceof java.util.concurrent.ExecutionException)
            && current.getCause() != null) {
            current = current.getCause();
        }
        return current;
    }

    private static String describe(Throwable error) {
        Throwable cause = unwrap(error);
        return cause.getMessage() != null ? cause.getMessage() : cause.getClass().getName();
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) return;
        forcedReconnectInFlight.set(false);
        generation.incrementAndGet();
        connectionAttempt.incrementAndGet();
        closeClient();
        scheduler.shutdownNow();
        try {
            scheduler.awaitTermination(Duration.ofSeconds(2).toMillis(), TimeUnit.MILLISECONDS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
        state.status("STOPPED");
    }
}
