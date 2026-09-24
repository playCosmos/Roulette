package io.github.playcosmos.roulettebridge.room;

import com.google.gson.Gson;
import com.google.gson.JsonParser;
import io.github.playcosmos.roulettebridge.db.BridgeDatabase;
import io.github.playcosmos.roulettebridge.soop.SoopDonation;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static io.github.playcosmos.roulettebridge.room.RoomModels.*;

public final class BoardGameRuntimeProbe {
    private static final Gson GSON = new Gson();

    private BoardGameRuntimeProbe() {}

    public static int run() {
        Path root = null;
        try {
            root = Files.createTempDirectory("roulette-board-runtime-probe-");
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
                        "probe-bno",
                        "Probe",
                        "2026-09-25T00:00:00+09:00",
                        null
                    )
                ))
                .toList());

            var request = new CreateRoomRequest(
                "Runtime Probe",
                List.of(new PlayerInput("soop-a", "A", null, 100)),
                new BoardInput("dimensions", 8, 6, null, "rounded"),
                new MovementInput("dice", 2, true, true, true),
                new RulesInput("destinationOnly", true, true),
                List.of(
                    new InstructionInput(
                        "EXTRA_THROW",
                        "한 번 더 던지기",
                        new AllocationInput("count", 0),
                        false,
                        JsonParser.parseString("""
                            {"type":"extraThrow","count":1}
                            """)
                    ),
                    new InstructionInput(
                        "MOVE_FORWARD",
                        "2칸 전진",
                        new AllocationInput("count", 0),
                        false,
                        JsonParser.parseString("""
                            {
                              "type":"move",
                              "direction":"forward",
                              "steps":{"mode":"fixed","value":2}
                            }
                            """)
                    ),
                    new InstructionInput(
                        "SKIP_NEXT_THROW",
                        "다음 던지기 스킵",
                        new AllocationInput("count", 0),
                        false,
                        JsonParser.parseString("""
                            {"type":"skipThrow","count":1}
                            """)
                    )
                ),
                new RandomPoolInput("custom", List.of(), null)
            );

            var created = rooms.create(request);
            var ready = rooms.commitPreview(created.roomId());
            require("READY".equals(ready.status()), "probe room must be READY");

            // 3+3 from START passes cell 3 and lands on cell 6.
            // Passing EXTRA_THROW must do nothing.
            // Cell 6 moves +2 to cell 8, then cell 8 SKIP_NEXT_THROW must execute and cancel the double bonus.
            patchCell(
                database,
                created.roomId(),
                3,
                new CellState(
                    3,
                    "INSTRUCTION",
                    "EXTRA_THROW",
                    "한 번 더 던지기",
                    JsonParser.parseString("""
                        {"type":"extraThrow","count":1}
                        """),
                    false,
                    false
                )
            );
            patchCell(
                database,
                created.roomId(),
                6,
                new CellState(
                    6,
                    "INSTRUCTION",
                    "MOVE_FORWARD",
                    "2칸 전진",
                    JsonParser.parseString("""
                        {
                          "type":"move",
                          "direction":"forward",
                          "steps":{"mode":"fixed","value":2}
                        }
                        """),
                    false,
                    false
                )
            );
            patchCell(
                database,
                created.roomId(),
                8,
                new CellState(
                    8,
                    "INSTRUCTION",
                    "SKIP_NEXT_THROW",
                    "다음 던지기 스킵",
                    JsonParser.parseString("""
                        {"type":"skipThrow","count":1}
                        """),
                    false,
                    false
                )
            );

            int[] randomValues = {
                2, 2,
                0, 1,
                4, 5,
                0, 1,
                0, 1,
                0, 1,
                0, 1
            };
            var randomIndex = new AtomicInteger();
            var dispatched = new ArrayList<BoardGameRuntimeEngine.BoardTurnEvent>();
            var runtime = new BoardGameRuntimeEngine(
                database,
                dispatched::add,
                bound -> Math.floorMod(
                    randomValues[Math.min(randomIndex.getAndIncrement(), randomValues.length - 1)],
                    bound
                )
            );

            var donation = new SoopDonation(
                "streamer",
                "soop-a",
                "A",
                100,
                1,
                "runtime-probe-1",
                1_000L
            );

            var first = runtime.process(donation);
            require(first.matchedRooms() == 1, "exact donation must match one READY room");
            require(first.processedRooms() == 1, "exact donation must process one room");
            require(first.duplicateRooms() == 0, "first donation cannot be duplicate");
            require(first.events().size() == 1, "first donation must produce one board turn");

            var turn = first.events().get(0);
            require(turn.throwResolutions().size() == 1, "destination skip must cancel double bonus throw");
            var resolved = turn.throwResolutions().get(0);
            require(resolved.dice() != null, "dice result missing");
            require(resolved.dice().values().equals(List.of(3, 3)), "probe must resolve 3+3");
            require(resolved.throwLandingPosition() == 6, "3+3 must land on cell 6");
            require("MOVE_FORWARD".equals(resolved.landing().instructionId()), "first destination instruction must execute");
            require(resolved.landingChain().size() == 2, "move landing must execute the newly reached cell instruction");
            require("MOVE_FORWARD".equals(resolved.landingChain().get(0).instructionId()), "cell 6 move instruction missing");
            require(resolved.landingChain().get(0).actionMoveSteps() == 2, "cell 6 must move +2");
            require("SKIP_NEXT_THROW".equals(resolved.landingChain().get(1).instructionId()), "cell 8 skip instruction must execute");
            require(resolved.bonusGranted(), "3+3 must grant a natural bonus");
            require(resolved.bonusConsumedBySkip(), "destination skip must consume double bonus");
            require(!resolved.nextThrowScheduled(), "bonus throw must disappear after destination skip");
            require(turn.endPosition() == 8, "player must finish at chained landing cell 8");
            require(turn.skipNextThrowsAfter() == 0, "skip must be consumed by pending bonus");
            require(dispatched.size() == 1, "board turn must dispatch after commit");

            var duplicate = runtime.process(donation);
            require(duplicate.processedRooms() == 0, "duplicate donation must not process again");
            require(duplicate.duplicateRooms() == 1, "duplicate donation must be detected");
            require(dispatched.size() == 1, "duplicate donation must not redispatch");

            var wrongAmount = runtime.process(new SoopDonation(
                "streamer",
                "soop-a",
                "A",
                200,
                1,
                "runtime-probe-wrong",
                2_000L
            ));
            require(wrongAmount.matchedRooms() == 0, "200 balloons must not match exact trigger 100");

            var snapshot = runtime.snapshot(created.roomId());
            require(snapshot.players().get(0).position() == 8, "chained runtime position must persist");
            require(snapshot.sequence() == 1, "duplicate/wrong donation must not advance sequence");

            runtime.pauseRoom(created.roomId(), "QUEUE", 10);
            var queuedOne = runtime.process(new SoopDonation(
                "streamer",
                "soop-a",
                "A",
                100,
                2,
                "runtime-probe-queue-1",
                3_000L
            ));
            var queuedTwo = runtime.process(new SoopDonation(
                "streamer",
                "soop-a",
                "A",
                100,
                3,
                "runtime-probe-queue-2",
                4_000L
            ));
            require(queuedOne.queuedRooms() == 1, "paused QUEUE mode must defer first donation");
            require(queuedTwo.queuedRooms() == 1, "paused QUEUE mode must defer second donation");
            require(dispatched.size() == 1, "queued donations must not dispatch before resume");

            expirePauseGrace(database, created.roomId());
            var afterGrace = runtime.process(new SoopDonation(
                "streamer",
                "soop-a",
                "A",
                100,
                4,
                "runtime-probe-after-grace",
                4_500L
            ));
            require(afterGrace.ignoredRooms() == 1, "donation after pause grace must be ignored");
            require(dispatched.size() == 1, "after-grace donation must not dispatch");

            var paused = rooms.find(created.roomId());
            require("PAUSED".equals(paused.lifecycle().state()), "room must report PAUSED");
            require(paused.lifecycle().queuedDonations() == 2, "paused room must report two queued donations");

            var resumed = runtime.resumeRoom(created.roomId());
            require(resumed.processedQueuedDonations() == 2, "resume must process two queued donations");
            require(resumed.events().size() == 2, "resume must emit two queued board turns");
            require(resumed.events().get(0).sequence() == 2, "first queued donation must keep FIFO sequence");
            require(resumed.events().get(1).sequence() == 3, "second queued donation must keep FIFO sequence");
            require(dispatched.size() == 3, "resume must dispatch queued turns in order");

            runtime.pauseRoom(created.roomId(), "IGNORE", 10);
            var ignoredDonation = new SoopDonation(
                "streamer",
                "soop-a",
                "A",
                100,
                4,
                "runtime-probe-ignore-1",
                5_000L
            );
            var ignored = runtime.process(ignoredDonation);
            require(ignored.ignoredRooms() == 1, "paused IGNORE mode must discard matching donation");
            require(dispatched.size() == 3, "ignored donation must not dispatch");

            var resumedIgnore = runtime.resumeRoom(created.roomId());
            require(resumedIgnore.processedQueuedDonations() == 0, "IGNORE mode must not create resume queue work");
            require(dispatched.size() == 3, "IGNORE resume must not dispatch ignored donation");

            var replayIgnored = runtime.process(ignoredDonation);
            require(replayIgnored.duplicateRooms() == 1, "ignored donation replay must stay ignored");
            require(dispatched.size() == 3, "ignored replay must not dispatch");

            var resumedSnapshot = runtime.snapshot(created.roomId());
            require(resumedSnapshot.sequence() == 3, "queue processing must advance runtime sequence to three");
            require(resumedSnapshot.players().get(0).position() == 22, "FIFO probe must finish at cell 22");

            patchRuntimeCell(
                database,
                created.roomId(),
                1,
                new CellState(
                    1,
                    "INSTRUCTION",
                    "MULTIPLY_NEXT_THROW",
                    "다음 던지기 2배",
                    JsonParser.parseString("""
                        {"type":"multiplyNextThrow","multiplier":2}
                        """),
                    false,
                    false
                )
            );
            patchRuntimeCell(
                database,
                created.roomId(),
                7,
                new CellState(
                    7,
                    "INSTRUCTION",
                    "IGNORE_NEXT_LANDING",
                    "다음 도착 칸 효과 무시",
                    JsonParser.parseString("""
                        {"type":"ignoreNextLanding","count":1}
                        """),
                    false,
                    false
                )
            );
            patchRuntimeCell(
                database,
                created.roomId(),
                10,
                new CellState(
                    10,
                    "INSTRUCTION",
                    "MOVE_TO_START_IGNORED",
                    "START로 이동",
                    JsonParser.parseString("""
                        {"type":"moveToStart"}
                        """),
                    false,
                    false
                )
            );
            patchRuntimeCell(
                database,
                created.roomId(),
                13,
                new CellState(
                    13,
                    "INSTRUCTION",
                    "MOVE_TO_START",
                    "START로 이동",
                    JsonParser.parseString("""
                        {"type":"moveToStart"}
                        """),
                    false,
                    false
                )
            );

            var multiplierSetup = runtime.process(new SoopDonation(
                "streamer", "soop-a", "A", 100, 5,
                "runtime-probe-multiplier-setup", 6_000L
            ));
            require(multiplierSetup.events().get(0).endPosition() == 1, "raw 3 from cell 22 must land on cell 1");
            var multiplierState = runtime.snapshot(created.roomId()).players().get(0);
            require(multiplierState.nextThrowMultiplier() == 2, "multiplier cell must arm x2 for next actual throw");

            var multiplied = runtime.process(new SoopDonation(
                "streamer", "soop-a", "A", 100, 6,
                "runtime-probe-multiplied", 7_000L
            ));
            var multipliedThrow = multiplied.events().get(0).throwResolutions().get(0);
            require(multipliedThrow.rawSteps() == 3, "multiplied throw raw value must remain 3");
            require(multipliedThrow.appliedMultiplier() == 2, "next throw must apply x2");
            require(multipliedThrow.steps() == 6, "effective movement must be 6");
            require(multiplied.events().get(0).endPosition() == 7, "x2 movement must land on cell 7");
            require(
                runtime.snapshot(created.roomId()).players().get(0).ignoreNextLandingEffects() == 1,
                "ignore-next-landing cell must arm one ignored landing"
            );

            var ignoredLanding = runtime.process(new SoopDonation(
                "streamer", "soop-a", "A", 100, 7,
                "runtime-probe-ignore-landing", 8_000L
            ));
            var ignoredResolution = ignoredLanding.events().get(0).throwResolutions().get(0);
            require(ignoredLanding.events().get(0).endPosition() == 10, "ignored landing must remain on cell 10");
            require(
                ignoredResolution.landingChain().get(0).effectIgnored(),
                "cell 10 START effect must be ignored once"
            );

            var moveToStart = runtime.process(new SoopDonation(
                "streamer", "soop-a", "A", 100, 8,
                "runtime-probe-start", 9_000L
            ));
            var startResolution = moveToStart.events().get(0).throwResolutions().get(0);
            require(startResolution.throwLandingPosition() == 13, "raw 3 from cell 10 must land on cell 13");
            require(startResolution.landingChain().size() == 2, "START move must include destination and START landing");
            require(startResolution.landingChain().get(0).actionMoveSteps() == -13, "START move must relocate to cell 0");
            require(moveToStart.events().get(0).endPosition() == 0, "START move must finish at cell 0");

            var finalSnapshot = runtime.snapshot(created.roomId());
            require(finalSnapshot.sequence() == 7, "built-in effects must advance sequence through seven");
            require(finalSnapshot.players().get(0).nextThrowMultiplier() == 1, "multiplier must be one-shot");
            require(finalSnapshot.players().get(0).ignoreNextLandingEffects() == 0, "landing ignore must be one-shot");

            System.out.println("[board-runtime-probe] PASS room=" + created.roomId());
            return 0;
        } catch (Exception error) {
            System.err.println("[board-runtime-probe] FAIL: " + error.getMessage());
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

    private static void expirePauseGrace(
        BridgeDatabase database,
        String roomId
    ) throws SQLException {
        try (var connection = database.open();
             var statement = connection.prepareStatement("""
                 UPDATE board_room
                 SET pause_grace_until = '2000-01-01T00:00:00Z'
                 WHERE room_id = ?
                 """)) {
            statement.setString(1, roomId);
            statement.executeUpdate();
        }
    }

    private static void patchRuntimeCell(
        BridgeDatabase database,
        String roomId,
        int cellIndex,
        CellState replacement
    ) throws SQLException {
        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                String json;
                try (var select = connection.prepareStatement("""
                    SELECT board_json
                    FROM board_game_state
                    WHERE room_id = ?
                    """)) {
                    select.setString(1, roomId);
                    try (var rows = select.executeQuery()) {
                        if (!rows.next()) throw new SQLException("probe runtime board missing");
                        json = rows.getString(1);
                    }
                }

                var board = GSON.fromJson(json, BoardPreview.class);
                var cells = new ArrayList<>(board.cells());
                cells.set(cellIndex, replacement);
                var patched = new BoardPreview(
                    board.seed(),
                    board.cellCount(),
                    board.layoutStyle(),
                    List.copyOf(cells),
                    board.rerollPool()
                );

                try (var update = connection.prepareStatement("""
                    UPDATE board_game_state
                    SET board_json = ?
                    WHERE room_id = ?
                    """)) {
                    update.setString(1, GSON.toJson(patched));
                    update.setString(2, roomId);
                    update.executeUpdate();
                }

                connection.commit();
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sqlError) throw sqlError;
                throw new SQLException("failed to patch runtime probe board", error);
            } finally {
                connection.setAutoCommit(true);
            }
        }
    }

    private static void patchCell(
        BridgeDatabase database,
        String roomId,
        int cellIndex,
        CellState replacement
    ) throws SQLException {
        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                String json;
                try (var select = connection.prepareStatement("""
                    SELECT committed_board_json
                    FROM board_room
                    WHERE room_id = ?
                    """)) {
                    select.setString(1, roomId);
                    try (var rows = select.executeQuery()) {
                        if (!rows.next()) throw new SQLException("probe committed board missing");
                        json = rows.getString(1);
                    }
                }

                var board = GSON.fromJson(json, BoardPreview.class);
                var cells = new ArrayList<>(board.cells());
                cells.set(cellIndex, replacement);
                var patched = new BoardPreview(
                    board.seed(),
                    board.cellCount(),
                    board.layoutStyle(),
                    List.copyOf(cells),
                    board.rerollPool()
                );

                try (var update = connection.prepareStatement("""
                    UPDATE board_room
                    SET committed_board_json = ?
                    WHERE room_id = ?
                    """)) {
                    update.setString(1, GSON.toJson(patched));
                    update.setString(2, roomId);
                    update.executeUpdate();
                }

                connection.commit();
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sqlError) throw sqlError;
                throw new SQLException("failed to patch runtime probe board", error);
            } finally {
                connection.setAutoCommit(true);
            }
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }
}
