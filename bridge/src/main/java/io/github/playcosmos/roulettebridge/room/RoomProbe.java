package io.github.playcosmos.roulettebridge.room;

import com.google.gson.JsonParser;
import io.github.playcosmos.roulettebridge.db.BridgeDatabase;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;

import static io.github.playcosmos.roulettebridge.room.RoomModels.*;

public final class RoomProbe {
    private RoomProbe() {}

    public static int run() {
        Path root = null;
        try {
            root = Files.createTempDirectory("roulette-room-probe-");
            var database = new BridgeDatabase(root.resolve("probe.db"));
            database.initialize();
            var rooms = new RoomService(database);

            var request = new CreateRoomRequest(
                "Room Probe",
                List.of(
                    new PlayerInput("soop-a", "A", null, 100),
                    new PlayerInput("soop-b", "B", null, 200),
                    new PlayerInput("soop-c", "C", null, 300),
                    new PlayerInput("soop-d", "D", null, 400)
                ),
                new BoardInput("cellCount", null, null, 52, "rect"),
                new MovementInput("dice", 2, true, true, true),
                List.of(
                    new InstructionInput(
                        "MOVE_FORWARD",
                        "전진",
                        new AllocationInput("ratio", 20),
                        true,
                        JsonParser.parseString("""
                            {
                              "type":"move",
                              "direction":"forward",
                              "steps":{"mode":"range","min":1,"max":4}
                            }
                            """)
                    ),
                    new InstructionInput(
                        "SKIP_NEXT_THROW",
                        "다음 던지기 스킵",
                        new AllocationInput("ratio", 10),
                        false,
                        JsonParser.parseString("""
                            {"type":"skipThrow","count":1}
                            """)
                    ),
                    new InstructionInput(
                        "CUSTOM_FIXED",
                        "고정 사용자 지시문",
                        new AllocationInput("count", 2),
                        false,
                        JsonParser.parseString("""
                            {"type":"display","text":"probe"}
                            """)
                    )
                ),
                null
            );

            var created = rooms.create(request);
            require("DRAFT".equals(created.status()), "room must start as DRAFT");
            require(created.config().board().columns() == 16, "52 cells must resolve to 16 columns");
            require(created.config().board().rows() == 12, "52 cells must resolve to 12 rows");
            require("rect".equals(created.config().board().layoutStyle()), "rect layout must persist");
            require(created.preview().cells().size() == 52, "preview cell count mismatch");

            var start = created.preview().cells().get(0);
            require(start.locked(), "START must be locked");
            require("START".equals(start.type()), "cell 0 must be START");
            require("NORMAL".equals(start.instructionId()), "START must always use NORMAL instruction");
            require(!start.rerollOnVacate(), "START must never reroll");

            require(created.preview().rerollPool().size() == 2, "ratio instructions must seed default reroll pool");
            require(
                created.preview().rerollPool().stream()
                    .anyMatch(entry -> "MOVE_FORWARD".equals(entry.instructionId()) && entry.weight() == 20.0d),
                "MOVE_FORWARD ratio weight must be inherited"
            );
            require(
                created.preview().rerollPool().stream()
                    .anyMatch(entry -> "SKIP_NEXT_THROW".equals(entry.instructionId()) && entry.weight() == 10.0d),
                "SKIP_NEXT_THROW ratio weight must be inherited"
            );

            for (var cell : created.preview().cells()) {
                if (!"MOVE_FORWARD".equals(cell.instructionId())) continue;
                var action = cell.action().getAsJsonObject();
                int resolved = action.get("resolvedSteps").getAsInt();
                require(resolved >= 1 && resolved <= 4, "resolved move range is outside 1~4");
            }

            var rerolled = rooms.rerollPreview(created.roomId());
            require(rerolled.preview().seed() != created.preview().seed(), "reroll must create a new seed");
            require("NORMAL".equals(rerolled.preview().cells().get(0).instructionId()), "reroll changed START");

            var ready = rooms.commitPreview(created.roomId());
            require("READY".equals(ready.status()), "commit must change room to READY");
            require(ready.committedBoard() != null, "committed board must be persisted");

            boolean blocked = false;
            try {
                rooms.rerollPreview(created.roomId());
            } catch (IllegalStateException expected) {
                blocked = true;
            }
            require(blocked, "READY room must reject preview reroll");

            var loaded = rooms.find(created.roomId());
            require("READY".equals(loaded.status()), "READY room must survive database reload");
            require(loaded.config().players().get(0).balloonTrigger() == 100, "exact donation trigger lost");

            System.out.println("[room-probe] PASS room=" + created.roomId());
            return 0;
        } catch (Exception error) {
            System.err.println("[room-probe] FAIL: " + error.getMessage());
            error.printStackTrace(System.err);
            return 1;
        } finally {
            if (root != null) {
                try (var paths = Files.walk(root)) {
                    paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                        try {
                            Files.deleteIfExists(path);
                        } catch (Exception ignored) {
                            // best effort probe cleanup
                        }
                    });
                } catch (Exception ignored) {
                    // best effort probe cleanup
                }
            }
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }
}
