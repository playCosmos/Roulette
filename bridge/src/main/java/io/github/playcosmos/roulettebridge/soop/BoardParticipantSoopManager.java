package io.github.playcosmos.roulettebridge.soop;

import io.github.playcosmos.roulettebridge.config.BridgeConfig;
import io.github.playcosmos.roulettebridge.room.RoomService;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

public final class BoardParticipantSoopManager implements AutoCloseable {
    private static final int RECENT_LIMIT = 20;

    private final RoomService rooms;
    private final BridgeConfig baseConfig;
    private final Consumer<SoopDonation> donationSink;
    private final ConcurrentHashMap<String, ChannelConnection> channels =
        new ConcurrentHashMap<>();
    private final ScheduledExecutorService scheduler =
        Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = Thread.ofVirtual()
                .name("board-participant-soop-reconciler")
                .unstarted(runnable);
            return thread;
        });
    private final AtomicBoolean started = new AtomicBoolean(false);
    private final AtomicBoolean closed = new AtomicBoolean(false);

    public BoardParticipantSoopManager(
        RoomService rooms,
        BridgeConfig baseConfig,
        Consumer<SoopDonation> donationSink
    ) {
        this.rooms = rooms;
        this.baseConfig = baseConfig.normalized();
        this.donationSink = donationSink;
    }

    public void start() {
        if (!started.compareAndSet(false, true) || closed.get()) return;
        scheduler.scheduleWithFixedDelay(
            this::reconcileSafely,
            0,
            1,
            TimeUnit.SECONDS
        );
    }

    public void refreshNow() {
        if (closed.get()) return;
        scheduler.execute(this::reconcileSafely);
    }

    public List<Map<String, Object>> snapshot(String roomId) {
        String normalizedRoomId = roomId == null ? "" : roomId.trim();
        var result = new ArrayList<Map<String, Object>>();
        for (var connection : channels.values()) {
            if (!connection.roomIds.contains(normalizedRoomId)) continue;
            result.add(connection.snapshot());
        }
        result.sort((left, right) ->
            String.valueOf(left.get("soopId"))
                .compareToIgnoreCase(String.valueOf(right.get("soopId")))
        );
        return List.copyOf(result);
    }

    private void reconcileSafely() {
        if (closed.get()) return;
        try {
            reconcile();
        } catch (Exception error) {
            System.err.println(
                "[board-soop] participant channel reconcile failed: "
                    + safeMessage(error)
            );
        }
    }

    private void reconcile() throws Exception {
        if (!baseConfig.soop().enabled()) {
            closeAllChannels();
            return;
        }

        var expected = new LinkedHashMap<String, LinkedHashSet<String>>();
        for (var summary : rooms.listActiveRoomSummaries()) {
            var room = rooms.find(summary.roomId());
            if (room.config() == null || room.config().players() == null) continue;
            for (var player : room.config().players()) {
                if (player == null) continue;
                String soopId = normalize(player.soopId());
                if (soopId.isBlank()) continue;
                expected.computeIfAbsent(soopId, ignored -> new LinkedHashSet<>())
                    .add(room.roomId());
            }
        }

        for (var entry : List.copyOf(channels.entrySet())) {
            if (expected.containsKey(entry.getKey())) continue;
            if (channels.remove(entry.getKey(), entry.getValue())) {
                entry.getValue().close();
                System.out.println(
                    "[board-soop] participant channel released: "
                        + entry.getKey()
                );
            }
        }

        for (var entry : expected.entrySet()) {
            String soopId = entry.getKey();
            Set<String> roomIds = Set.copyOf(entry.getValue());
            var current = channels.get(soopId);
            if (current != null) {
                current.roomIds = roomIds;
                continue;
            }

            var state = new SoopRuntimeState(soopId);
            var channelConfig = new BridgeConfig(
                soopId,
                baseConfig.ticket(),
                baseConfig.server(),
                baseConfig.storage(),
                baseConfig.soop()
            ).normalized();
            var adapter = new SoopBridgeAdapter(
                channelConfig,
                state,
                donation -> onDonation(soopId, donation),
                (channelId, event) -> {}
            );
            var created = new ChannelConnection(
                soopId,
                state,
                adapter,
                roomIds
            );
            var raced = channels.putIfAbsent(soopId, created);
            if (raced == null) {
                System.out.println(
                    "[board-soop] participant channel acquired: "
                        + soopId
                        + " rooms="
                        + roomIds
                );
                adapter.start();
            } else {
                created.close();
                raced.roomIds = roomIds;
            }
        }
    }

    private void onDonation(String soopId, SoopDonation donation) {
        var connection = channels.get(soopId);
        if (connection == null || closed.get()) return;

        connection.record(donation);
        try {
            donationSink.accept(donation);
        } catch (RuntimeException error) {
            System.err.println(
                "[board-soop] participant donation sink failed: "
                    + safeMessage(error)
            );
        }
    }

    private void closeAllChannels() {
        for (var entry : List.copyOf(channels.entrySet())) {
            if (channels.remove(entry.getKey(), entry.getValue())) {
                entry.getValue().close();
            }
        }
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) return;
        closeAllChannels();
        scheduler.shutdownNow();
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim();
    }

    private static String safeMessage(Throwable error) {
        if (error == null) return "unknown error";
        String message = error.getMessage();
        return message == null || message.isBlank()
            ? error.getClass().getSimpleName()
            : message;
    }

    private static final class ChannelConnection implements AutoCloseable {
        private final String soopId;
        private final SoopRuntimeState state;
        private final SoopBridgeAdapter adapter;
        private final AtomicLong donationEvents = new AtomicLong();
        private final AtomicLong totalBalloons = new AtomicLong();
        private final ArrayDeque<Map<String, Object>> recent = new ArrayDeque<>();
        private volatile Set<String> roomIds;

        private ChannelConnection(
            String soopId,
            SoopRuntimeState state,
            SoopBridgeAdapter adapter,
            Set<String> roomIds
        ) {
            this.soopId = soopId;
            this.state = state;
            this.adapter = adapter;
            this.roomIds = roomIds;
        }

        private void record(SoopDonation donation) {
            donationEvents.incrementAndGet();
            totalBalloons.addAndGet(donation.balloonCount());

            var item = new LinkedHashMap<String, Object>();
            item.put("donorId", donation.donorId());
            item.put("nickname", donation.nickname());
            item.put("balloonCount", donation.balloonCount());
            item.put("fanOrder", donation.fanOrder());
            item.put("occurredAtEpochMs", donation.receivedAtEpochMs());

            synchronized (recent) {
                recent.addFirst(item);
                while (recent.size() > RECENT_LIMIT) recent.removeLast();
            }
        }

        private Map<String, Object> snapshot() {
            var result = new LinkedHashMap<String, Object>();
            result.put("soopId", soopId);
            result.put("roomIds", roomIds);
            result.putAll(state.snapshot());
            result.put("donationEvents", donationEvents.get());
            result.put("totalBalloons", totalBalloons.get());
            synchronized (recent) {
                result.put("recentDonations", List.copyOf(recent));
            }
            return result;
        }

        @Override
        public void close() {
            adapter.close();
        }
    }
}
