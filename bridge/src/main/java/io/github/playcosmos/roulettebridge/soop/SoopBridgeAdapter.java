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
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

public final class SoopBridgeAdapter implements AutoCloseable {
    private final BridgeConfig config;
    private final SoopRuntimeState state;
    private final Consumer<SoopDonation> donationSink;
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(
        Thread.ofVirtual().name("soop-supervisor-", 0).factory()
    );
    private final AtomicBoolean closed = new AtomicBoolean(false);
    private final AtomicBoolean probeScheduled = new AtomicBoolean(false);
    private SOOPClient client;

    public SoopBridgeAdapter(
        BridgeConfig config,
        SoopRuntimeState state,
        Consumer<SoopDonation> donationSink
    ) {
        this.config = Objects.requireNonNull(config, "config");
        this.state = Objects.requireNonNull(state, "state");
        this.donationSink = Objects.requireNonNull(donationSink, "donationSink");
    }

    public void start() {
        if (!config.soop().enabled()) {
            state.status("DISABLED");
            System.out.println("[soop] disabled by config");
            return;
        }
        if (config.streamerId() == null || config.streamerId().isBlank() || "STREAMER_ID".equals(config.streamerId())) {
            state.status("WAITING_FOR_STREAMER_ID");
            System.out.println("[soop] streamerId is not configured");
            return;
        }
        scheduleProbe(0);
    }

    private void scheduleProbe(long delaySeconds) {
        if (closed.get() || !probeScheduled.compareAndSet(false, true)) return;
        scheduler.schedule(() -> {
            probeScheduled.set(false);
            probeAndConnect();
        }, Math.max(0, delaySeconds), TimeUnit.SECONDS);
    }

    private void probeAndConnect() {
        if (closed.get()) return;

        closeClient();
        client = new SOOPClient();
        attachListeners(client);
        state.status("PROBING");

        client.live().detail(config.streamerId()).whenComplete((detail, error) -> {
            if (closed.get()) return;
            if (error != null) {
                state.status("OFFLINE_OR_UNAVAILABLE");
                state.error(unwrap(error));
                System.err.println("[soop] live probe failed: " + describe(error));
                scheduleProbe(config.soop().offlinePollSeconds());
                return;
            }

            state.live(detail.bno(), detail.title());
            state.status("CONNECTING");
            System.out.println("[soop] live found: bno=" + detail.bno() + " title=" + detail.title());

            var chat = client.add(config.streamerId());
            chat.connectToChat().whenComplete((ignored, connectError) -> {
                if (closed.get()) return;
                if (connectError != null) {
                    state.status("CONNECTION_FAILED");
                    state.error(unwrap(connectError));
                    System.err.println("[soop] chat connection failed: " + describe(connectError));
                    scheduleProbe(config.soop().offlinePollSeconds());
                }
            });
        });
    }

    private void attachListeners(SOOPClient soop) {
        soop.on(ChatEvent.JOIN_CHANNEL, (String bid, JoinChannelEvent event) -> {
            state.status("CONNECTED");
            System.out.println("[soop] joined chat: " + bid);
        });

        soop.on(ChatEvent.SEND_BALLOON, (String bid, SendBalloonEvent event) -> {
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
            state.status("RECONNECTING");
            System.out.println("[soop] reconnecting " + event.attemptNumber() + "/" + event.maxAttempts());
        });

        soop.on(ChatEvent.RECONNECTED, (String bid, ReconnectedEvent event) -> {
            state.status("CONNECTED");
            System.out.println("[soop] reconnected: " + bid);
        });

        soop.on(ChatEvent.DISCONNECTED, (String bid, DisconnectedEvent event) -> {
            state.status(event.causedByError() ? "DISCONNECTED_ERROR" : "DISCONNECTED");
            if (event.causedByError()) state.error(new IllegalStateException(event.reason()));
            System.out.println("[soop] disconnected: code=" + event.statusCode() + " reason=" + event.reason());
            scheduleProbe(config.soop().offlinePollSeconds());
        });
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
