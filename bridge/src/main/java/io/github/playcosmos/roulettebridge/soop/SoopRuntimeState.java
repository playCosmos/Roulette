package io.github.playcosmos.roulettebridge.soop;

import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

public final class SoopRuntimeState {
    private final String streamerId;
    private final AtomicReference<String> status = new AtomicReference<>("IDLE");
    private final AtomicReference<String> bno = new AtomicReference<>();
    private final AtomicReference<String> title = new AtomicReference<>();
    private final AtomicReference<String> lastError = new AtomicReference<>();
    private final AtomicReference<String> lastDonationAt = new AtomicReference<>();
    private final AtomicLong donationEvents = new AtomicLong();

    public SoopRuntimeState(String streamerId) {
        this.streamerId = streamerId;
    }

    public void status(String value) {
        status.set(value);
    }

    public String status() {
        return status.get();
    }

    public void live(String bno, String title) {
        this.bno.set(bno);
        this.title.set(title);
        this.lastError.set(null);
    }

    public void error(Throwable error) {
        String message = error == null ? null : error.getMessage();
        if (message == null && error != null) message = error.getClass().getSimpleName();
        lastError.set(message);
    }

    public void donationReceived() {
        donationEvents.incrementAndGet();
        lastDonationAt.set(OffsetDateTime.now().toString());
    }

    public Map<String, Object> snapshot() {
        var result = new LinkedHashMap<String, Object>();
        result.put("streamerId", streamerId);
        result.put("status", status.get());
        result.put("bno", bno.get());
        result.put("title", title.get());
        result.put("donationEvents", donationEvents.get());
        result.put("lastDonationAt", lastDonationAt.get());
        result.put("lastError", lastError.get());
        return result;
    }
}
