package io.github.playcosmos.roulettebridge.room;

import com.github.getcurrentthread.soopapi.SOOPClient;
import io.github.playcosmos.roulettebridge.operations.SoopUserLookupService;
import java.net.ConnectException;
import java.net.UnknownHostException;
import java.net.http.HttpTimeoutException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static io.github.playcosmos.roulettebridge.room.RoomModels.*;

public final class SoopParticipantLiveService implements ParticipantLiveChecker {
    private static final long LOOKUP_TIMEOUT_SECONDS = 8L;
    private final SoopUserLookupService userLookup = new SoopUserLookupService();

    @Override
    public List<PlayerConfig> check(List<PlayerConfig> players) {
        if (players == null || players.isEmpty()) return List.of();

        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var futures = players.stream()
                .map(player -> java.util.concurrent.CompletableFuture.supplyAsync(
                    () -> checkOne(player),
                    executor
                ))
                .toList();

            var checked = new ArrayList<PlayerConfig>(players.size());
            for (var future : futures) {
                checked.add(future.join());
            }
            return List.copyOf(checked);
        }
    }

    private PlayerConfig checkOne(PlayerConfig player) {
        String checkedAt = OffsetDateTime.now().toString();
        String displayName = player.displayName();
        String profileImageUrl = player.profileImageUrl();

        if (displayName == null || displayName.isBlank()) {
            try {
                var lookup = userLookup.lookup(player.soopId(), "id");
                if (lookup.resolved() && lookup.match() != null) {
                    displayName = lookup.match().nickname();
                    if (
                        (profileImageUrl == null || profileImageUrl.isBlank())
                        && lookup.match().profileImage() != null
                        && !lookup.match().profileImage().isBlank()
                    ) {
                        profileImageUrl = lookup.match().profileImage();
                    }
                }
            } catch (Exception error) {
                System.err.println(
                    "[board-room] SOOP nickname lookup failed for "
                        + player.soopId() + ": " + message(unwrap(error))
                );
            }
        }

        try (var client = new SOOPClient()) {
            var detail = client.live()
                .detail(player.soopId())
                .get(LOOKUP_TIMEOUT_SECONDS, TimeUnit.SECONDS);

            return new PlayerConfig(
                player.soopId(),
                displayName,
                profileImageUrl,
                player.balloonTrigger(),
                new PlayerLiveStatus(
                    "LIVE",
                    detail.bno(),
                    detail.title(),
                    checkedAt,
                    null
                )
            );
        } catch (Exception error) {
            Throwable cause = unwrap(error);
            boolean transportFailure =
                cause instanceof TimeoutException
                || cause instanceof HttpTimeoutException
                || cause instanceof ConnectException
                || cause instanceof UnknownHostException;

            return new PlayerConfig(
                player.soopId(),
                displayName,
                profileImageUrl,
                player.balloonTrigger(),
                new PlayerLiveStatus(
                    transportFailure ? "CHECK_FAILED" : "OFFLINE_OR_UNAVAILABLE",
                    null,
                    null,
                    checkedAt,
                    message(cause)
                )
            );
        }
    }

    private static Throwable unwrap(Throwable error) {
        Throwable current = error;
        while ((current instanceof CompletionException
            || current instanceof ExecutionException)
            && current.getCause() != null) {
            current = current.getCause();
        }
        return current;
    }

    private static String message(Throwable error) {
        String value = error == null ? null : error.getMessage();
        if (value != null && !value.isBlank()) return value;
        return error == null ? null : error.getClass().getSimpleName();
    }
}
