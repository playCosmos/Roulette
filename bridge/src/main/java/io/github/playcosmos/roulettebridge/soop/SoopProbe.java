package io.github.playcosmos.roulettebridge.soop;

import com.github.getcurrentthread.soopapi.SOOPClient;
import com.github.getcurrentthread.soopapi.event.ChatEvent;
import com.github.getcurrentthread.soopapi.event.model.DisconnectedEvent;
import com.github.getcurrentthread.soopapi.event.model.JoinChannelEvent;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

public final class SoopProbe {
    private SoopProbe() {}

    public static int run(String streamerId) {
        System.out.println("[probe] streamerId=" + streamerId);
        try (var client = new SOOPClient()) {
            var detail = client.live().detail(streamerId).get(20, TimeUnit.SECONDS);
            System.out.println("[probe] live bno=" + detail.bno());
            System.out.println("[probe] title=" + detail.title());
            System.out.println("[probe] chat=" + detail.chatDomain() + ":" + detail.chatPort());

            var joined = new CountDownLatch(1);
            var failure = new AtomicReference<String>();

            client.on(ChatEvent.JOIN_CHANNEL, (String bid, JoinChannelEvent event) -> {
                System.out.println("[probe] JOIN_CHANNEL=" + bid);
                joined.countDown();
            });
            client.on(ChatEvent.DISCONNECTED, (String bid, DisconnectedEvent event) -> {
                if (joined.getCount() > 0 && event.causedByError()) {
                    failure.compareAndSet(null, event.reason());
                }
            });

            client.add(streamerId);
            if (!joined.await(30, TimeUnit.SECONDS)) {
                String reason = failure.get();
                System.err.println("[probe] FAIL: chat join timeout" + (reason == null ? "" : " / " + reason));
                return 3;
            }

            System.out.println("[probe] OK: live detail + chat join verified");
            return 0;
        } catch (Exception error) {
            Throwable cause = unwrap(error);
            String message = cause.getMessage() != null ? cause.getMessage() : cause.getClass().getName();
            System.err.println("[probe] FAIL: " + message);
            return 2;
        }
    }

    private static Throwable unwrap(Throwable error) {
        Throwable current = error;
        while (current.getCause() != null
            && (current instanceof java.util.concurrent.CompletionException
                || current instanceof java.util.concurrent.ExecutionException)) {
            current = current.getCause();
        }
        return current;
    }
}
