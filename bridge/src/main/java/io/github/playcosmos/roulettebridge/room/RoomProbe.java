package io.github.playcosmos.roulettebridge.room;

import com.google.gson.JsonParser;
import io.github.playcosmos.roulettebridge.db.BridgeDatabase;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.OffsetDateTime;
import java.util.ArrayList;
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
            var rooms = new RoomService(database, players -> players.stream()
                .map(player -> new PlayerConfig(
                    player.soopId(),
                    player.displayName(),
                    player.profileImageUrl(),
                    player.balloonTrigger(),
                    new PlayerLiveStatus(
                        "LIVE",
                        "probe-bno-" + player.soopId(),
                        "Probe " + player.displayName(),
                        "2026-09-25T00:00:00+09:00",
                        null
                    )
                ))
                .toList());

            var cycleValidator = new FixedInstructionCycleValidator();
            require(
                cycleValidator.findCycle(fixedCycleBoard(false)).isPresent(),
                "fixed move cycle must be detected"
            );
            require(
                cycleValidator.findCycle(fixedCycleBoard(true)).isEmpty(),
                "cycle through a random cell must be ignored"
            );

            var invalidRandomRatio = new CreateRoomRequest(
                "Invalid Random Ratio",
                List.of(new PlayerInput("random-user", "Random", null, 10)),
                new BoardInput("dimensions", 8, 6, null, "rounded"),
                new MovementInput("dice", 1, true, true, true),
                new RulesInput("destinationOnly", true, true),
                List.of(new InstructionInput(
                    "RANDOM_MOVE",
                    "랜덤 전진",
                    new AllocationInput("ratio", 20),
                    true,
                    JsonParser.parseString("""
                        {
                          "type":"move",
                          "direction":"forward",
                          "steps":{"mode":"fixed","value":1}
                        }
                        """)
                )),
                new RandomPoolInput("custom", List.of(
                    new RandomPoolEntry("RANDOM_MOVE", 1)
                ), null)
            );
            require(
                rooms.validate(invalidRandomRatio).errors().stream()
                    .anyMatch(error -> error.field().endsWith(".allocation.mode")),
                "random cells must reject ratio allocation"
            );

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
                new RulesInput("destinationOnly", true, true),
                List.of(
                    new InstructionInput(
                        "MOVE_FORWARD",
                        "전진",
                        new AllocationInput("ratio", 20),
                        false,
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

            var invalidRetention = new CreateRoomRequest(
                request.name(),
                request.players(),
                request.board(),
                request.movement(),
                request.rules(),
                request.instructions(),
                request.randomPool(),
                481,
                "QUEUE"
            );
            require(
                rooms.validate(invalidRetention).errors().stream()
                    .anyMatch(error -> "retentionMinutes".equals(error.field())),
                "retention above 480 minutes must be rejected"
            );

            var invalidPauseGrace = new CreateRoomRequest(
                request.name(),
                request.players(),
                request.board(),
                request.movement(),
                request.rules(),
                request.instructions(),
                request.randomPool(),
                240,
                "QUEUE",
                121
            );
            require(
                rooms.validate(invalidPauseGrace).errors().stream()
                    .anyMatch(error -> "pauseGraceSeconds".equals(error.field())),
                "pause grace above 120 seconds must be rejected"
            );

            var created = rooms.create(request);
            require("DRAFT".equals(created.status()), "room must start as DRAFT");
            require(created.lifecycle() != null, "room lifecycle must be returned");
            require("DRAFT".equals(created.lifecycle().state()), "new room lifecycle must start DRAFT");
            require(created.lifecycle().retentionMinutes() == 240, "default retention must be 240 minutes");
            require("QUEUE".equals(created.lifecycle().pauseDonationMode()), "pause donation default must be QUEUE");
            require(created.lifecycle().pauseGraceSeconds() == 10, "pause grace default must be 10 seconds");
            require(created.lifecycle().expiresAt() != null, "room expiry timestamp must be persisted");
            require(created.config().board().columns() == 16, "52 cells must resolve to 16 columns");
            require(created.config().board().rows() == 12, "52 cells must resolve to 12 rows");
            require("rect".equals(created.config().board().layoutStyle()), "rect layout must persist");
            require(
                "destinationOnly".equals(created.config().rules().landingInstructionMode()),
                "landing instruction mode must be destinationOnly"
            );
            require(
                created.config().rules().resolveLandingBeforeBonusThrow(),
                "landing instruction must resolve before bonus throw"
            );
            require(
                created.config().rules().skipNextThrowConsumesBonus(),
                "skip-next-throw must consume pending bonus throw"
            );
            require(created.preview().cells().size() == 52, "preview cell count mismatch");
            require(
                created.config().players().stream()
                    .allMatch(player -> player.live() != null && "LIVE".equals(player.live().status())),
                "participant live checks must be persisted in room config"
            );

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

            long moveForwardCount = created.preview().cells().stream()
                .filter(cell -> "MOVE_FORWARD".equals(cell.instructionId()))
                .count();
            long skipCount = created.preview().cells().stream()
                .filter(cell -> "SKIP_NEXT_THROW".equals(cell.instructionId()))
                .count();
            long fixedCount = created.preview().cells().stream()
                .filter(cell -> "CUSTOM_FIXED".equals(cell.instructionId()))
                .count();

            require(moveForwardCount == 10, "20% ratio apportionment mismatch");
            require(skipCount == 5, "10% ratio apportionment mismatch");
            require(fixedCount == 2, "fixed count allocation mismatch");

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

            boolean earlyExtensionBlocked = false;
            try {
                rooms.extendLifetime(created.roomId(), 60);
            } catch (IllegalStateException expected) {
                earlyExtensionBlocked = true;
            }
            require(
                earlyExtensionBlocked,
                "room extension must be blocked when more than 60 minutes remain"
            );

            setRoomNearExpiry(database, created.roomId(), 480, 30);

            boolean oversizedExtensionBlocked = false;
            try {
                rooms.extendLifetime(created.roomId(), 121);
            } catch (IllegalArgumentException expected) {
                oversizedExtensionBlocked = true;
            }
            require(
                oversizedExtensionBlocked,
                "single extension above 120 minutes must be rejected"
            );

            var extended = rooms.extendLifetime(created.roomId(), 120);
            require(
                extended.lifecycle().retentionMinutes() == 600,
                "manual extension must be allowed to exceed the 480-minute creation limit"
            );

            boolean immediateReextensionBlocked = false;
            try {
                rooms.extendLifetime(created.roomId(), 1);
            } catch (IllegalStateException expected) {
                immediateReextensionBlocked = true;
            }
            require(
                immediateReextensionBlocked,
                "another extension must wait until remaining time is within 60 minutes again"
            );

            var secondRoom = rooms.create(request);
            require("DRAFT".equals(secondRoom.status()), "second room may exist only as DRAFT");

            boolean secondCommitBlocked = false;
            try {
                rooms.commitPreview(secondRoom.roomId());
            } catch (IllegalStateException expected) {
                secondCommitBlocked = true;
            }
            require(secondCommitBlocked, "second READY room must be rejected");
            require(
                "DRAFT".equals(rooms.find(secondRoom.roomId()).status()),
                "rejected second room must remain DRAFT"
            );

            expireRoom(database, secondRoom.roomId());
            require(rooms.terminateExpiredRooms() >= 1, "expired room must auto-terminate");
            require(
                "TERMINATED".equals(rooms.find(secondRoom.roomId()).lifecycle().state()),
                "expired room lifecycle must be TERMINATED"
            );

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
            require(
                "LIVE".equals(loaded.config().players().get(0).live().status()),
                "participant live status lost after database reload"
            );

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

    private static void setRoomNearExpiry(
        BridgeDatabase database,
        String roomId,
        int retentionMinutes,
        int remainingMinutes
    ) throws Exception {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 UPDATE board_room
                 SET retention_minutes = ?,
                     expires_at = ?
                 WHERE room_id = ?
                 """)) {
            statement.setInt(1, retentionMinutes);
            statement.setString(
                2,
                OffsetDateTime.now().plusMinutes(remainingMinutes).toString()
            );
            statement.setString(3, roomId);
            statement.executeUpdate();
        }
    }

    private static void expireRoom(
        BridgeDatabase database,
        String roomId
    ) throws Exception {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 UPDATE board_room
                 SET expires_at = '2000-01-01T00:00:00Z'
                 WHERE room_id = ?
                 """)) {
            statement.setString(1, roomId);
            statement.executeUpdate();
        }
    }

    private static BoardPreview fixedCycleBoard(boolean randomSecondCell) {
        var cells = new ArrayList<CellState>();
        for (int i = 0; i < 10; i++) {
            cells.add(new CellState(
                i,
                i == 0 ? "START" : "NORMAL",
                "NORMAL",
                i == 0 ? "START" : "",
                null,
                false,
                i == 0
            ));
        }

        cells.set(2, new CellState(
            2,
            "INSTRUCTION",
            "MOVE_A",
            "+2",
            JsonParser.parseString("""
                {
                  "type":"move",
                  "direction":"forward",
                  "steps":{"mode":"fixed","value":2}
                }
                """),
            false,
            false
        ));
        cells.set(4, new CellState(
            4,
            "INSTRUCTION",
            "MOVE_B",
            "-2",
            JsonParser.parseString("""
                {
                  "type":"move",
                  "direction":"backward",
                  "steps":{"mode":"fixed","value":2}
                }
                """),
            randomSecondCell,
            false
        ));

        return new BoardPreview(
            1L,
            10,
            "rounded",
            List.copyOf(cells),
            List.of()
        );
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }
}
