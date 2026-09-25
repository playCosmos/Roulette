package io.github.playcosmos.roulettebridge.room;

import com.google.gson.JsonParser;
import io.github.playcosmos.roulettebridge.db.BridgeDatabase;
import io.github.playcosmos.roulettebridge.soop.SoopDonation;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static io.github.playcosmos.roulettebridge.room.RoomModels.*;

public final class MixedMovementProbe {
    private MixedMovementProbe() {}

    public static void main(String[] args) {
        System.exit(run());
    }

    public static int run() {
        Path root = null;
        try {
            root = Files.createTempDirectory("mixed-movement-probe-");
            var database = new BridgeDatabase(root.resolve("probe.db"));
            database.initialize();

            var rooms = new RoomService(database, players -> players.stream()
                .map(player -> new PlayerConfig(
                    player.soopId(),
                    player.displayName() == null || player.displayName().isBlank()
                        ? player.soopId()
                        : player.displayName(),
                    player.profileImageUrl(),
                    player.balloonTrigger(),
                    new PlayerLiveStatus("LIVE", "probe", "Probe", "now", null)
                ))
                .toList());

            var request = new CreateRoomRequest(
                "Mixed Probe",
                List.of(new PlayerInput("soop-a", "", null, 100)),
                new BoardInput("dimensions", 8, 6, null, "rect"),
                new MovementInput("mixed", 2, true, true, true),
                new RulesInput("destinationOnly", true, true),
                List.of(),
                new RandomPoolInput("custom", List.of(), null)
            );

            var room = rooms.create(request);
            rooms.commitPreview(room.roomId());

            int[] randomValues = {
                // Turn 1: select dice, double 1+1, then bonus 2+3.
                0, 0, 0, 1, 2,
                // Turn 2: select yut, MO, then bonus GAE.
                1, 0, 0, 0, 0, 1, 1, 0, 0
            };
            var index = new AtomicInteger();
            var runtime = new BoardGameRuntimeEngine(
                database,
                event -> {},
                bound -> Math.floorMod(
                    randomValues[Math.min(index.getAndIncrement(), randomValues.length - 1)],
                    bound
                )
            );

            var first = runtime.process(new SoopDonation(
                "streamer", "soop-a", "A", 100, 1, "mixed-1", 1_000L
            ));
            require(first.events().size() == 1, "first mixed turn missing");
            var firstTurn = first.events().get(0);
            require("dice".equals(firstTurn.generator()), "first mixed turn must select dice");
            require(firstTurn.throwResolutions().size() == 2, "dice double must create exactly one bonus throw");
            require(firstTurn.throwResolutions().stream().allMatch(r -> "dice".equals(r.generator())),
                "all bonus throws in dice turn must stay dice");
            require(firstTurn.throwResolutions().stream().allMatch(r -> r.dice() != null && r.yut() == null),
                "dice turn must not switch to yut");

            var second = runtime.process(new SoopDonation(
                "streamer", "soop-a", "A", 100, 2, "mixed-2", 2_000L
            ));
            require(second.events().size() == 1, "second mixed turn missing");
            var secondTurn = second.events().get(0);
            require("yut".equals(secondTurn.generator()), "second mixed turn must select yut");
            require(secondTurn.throwResolutions().size() == 2, "MO must create exactly one bonus throw");
            require(secondTurn.throwResolutions().stream().allMatch(r -> "yut".equals(r.generator())),
                "all bonus throws in yut turn must stay yut");
            require(secondTurn.throwResolutions().stream().allMatch(r -> r.yut() != null && r.dice() == null),
                "yut turn must not switch to dice");

            System.out.println("[mixed-movement-probe] PASS");
            return 0;
        } catch (Exception error) {
            System.err.println("[mixed-movement-probe] FAIL: " + error.getMessage());
            error.printStackTrace(System.err);
            return 1;
        } finally {
            if (root != null) {
                try (var paths = Files.walk(root)) {
                    paths.sorted((a, b) -> b.compareTo(a)).forEach(path -> {
                        try { Files.deleteIfExists(path); } catch (Exception ignored) {}
                    });
                } catch (Exception ignored) {}
            }
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }
}
