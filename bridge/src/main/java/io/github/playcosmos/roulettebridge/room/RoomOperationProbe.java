package io.github.playcosmos.roulettebridge.room;

import io.github.playcosmos.roulettebridge.db.BridgeDatabase;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static io.github.playcosmos.roulettebridge.room.RoomModels.*;

public final class RoomOperationProbe {
    private RoomOperationProbe() {}

    public static void main(String[] args) {
        System.exit(run());
    }

    public static int run() {
        Path root = null;
        try {
            root = Files.createTempDirectory("room-operation-probe-");
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
                "Operation Probe",
                List.of(new PlayerInput("soop-a", "A", null, 100)),
                new BoardInput("dimensions", 8, 6, null, "rect"),
                new MovementInput("dice", 1, false, false, false),
                new RulesInput("destinationOnly", true, true),
                List.of(),
                new RandomPoolInput("custom", List.of(), null)
            );

            var room = rooms.create(request);
            rooms.commitPreview(room.roomId());

            var runtime = new BoardGameRuntimeEngine(
                database,
                event -> {},
                bound -> 0
            );

            runtime.pauseRoom(room.roomId(), "IGNORE", 0);

            var manualTurn = runtime.manualTurn(room.roomId(), "soop-a");
            require(
                manualTurn.endPosition() == 1,
                "manual turn must work while PAUSED"
            );

            var positionEvent = runtime.setPlayerPosition(
                room.roomId(),
                "soop-a",
                5
            );
            require(
                positionEvent.startPosition() == 1
                    && positionEvent.endPosition() == 5,
                "manual position correction mismatch"
            );
            require(
                positionEvent.throwResolutions().isEmpty(),
                "manual position correction must not resolve landing effects"
            );

            var snapshot = runtime.snapshot(room.roomId());
            require(
                snapshot.players().size() == 1
                    && snapshot.players().get(0).position() == 5,
                "runtime position was not persisted"
            );

            runtime.terminateRoom(room.roomId());

            boolean turnBlocked = false;
            try {
                runtime.manualTurn(room.roomId(), "soop-a");
            } catch (IllegalStateException expected) {
                turnBlocked = true;
            }
            require(turnBlocked, "terminated room manual turn must be blocked");

            boolean positionBlocked = false;
            try {
                runtime.setPlayerPosition(room.roomId(), "soop-a", 2);
            } catch (Exception expected) {
                positionBlocked = true;
            }
            require(
                positionBlocked,
                "terminated room position correction must be blocked"
            );

            System.out.println("[room-operation-probe] PASS");
            return 0;
        } catch (Exception error) {
            System.err.println("[room-operation-probe] FAIL: " + error.getMessage());
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
