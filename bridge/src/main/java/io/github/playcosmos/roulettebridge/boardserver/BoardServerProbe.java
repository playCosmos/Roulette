package io.github.playcosmos.roulettebridge.boardserver;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;

public final class BoardServerProbe {
    private BoardServerProbe() {}

    public static int run() {
        Path root = null;
        try {
            root = Files.createTempDirectory("ramyani-board-server-probe-");
            var database = new BoardGameDatabase(root.resolve("board-game.db"));
            database.initialize();

            var tables = new HashSet<String>();
            try (var connection = database.open();
                 var statement = connection.prepareStatement(
                     "SELECT name FROM sqlite_master WHERE type='table'"
                 );
                 var rows = statement.executeQuery()) {
                while (rows.next()) tables.add(rows.getString(1));
            }

            require(tables.contains("board_room"), "board_room table missing");
            require(tables.contains("board_game_state"), "board_game_state table missing");
            require(tables.contains("board_game_event"), "board_game_event table missing");
            require(tables.contains("board_game_deferred_donation"), "deferred donation table missing");
            require(!tables.contains("ticket"), "roulette ticket table must not exist");
            require(!tables.contains("donor"), "roulette donor table must not exist");
            require(!tables.contains("donation_event"), "roulette donation table must not exist");

            System.out.println("[board-server-probe] PASS");
            return 0;
        } catch (Exception error) {
            System.err.println("[board-server-probe] FAIL: " + error.getMessage());
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
