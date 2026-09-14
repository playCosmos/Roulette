package io.github.playcosmos.roulettebridge.recovery;

import io.github.playcosmos.roulettebridge.config.BridgeConfig;
import io.github.playcosmos.roulettebridge.db.BridgeDatabase;
import io.github.playcosmos.roulettebridge.issuance.DonationIssuanceEngine;
import io.github.playcosmos.roulettebridge.issuance.TicketIssueEvent;
import io.github.playcosmos.roulettebridge.soop.SoopDonation;
import io.github.playcosmos.roulettebridge.storage.TicketArchiveService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.concurrent.atomic.AtomicInteger;

public final class PhaseFProbe {
    private static final byte[] ONE_PIXEL_PNG = Base64.getDecoder().decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0n0AAAAASUVORK5CYII="
    );

    private PhaseFProbe() {}

    public static int run() {
        Path root = null;
        try {
            root = Files.createTempDirectory("roulette-phase-f-");
            var database = new BridgeDatabase(root.resolve("data/roulette.db"));
            database.initialize();

            var pending = new AtomicInteger();
            var created = new ArrayList<TicketIssueEvent>();
            var issuance = new DonationIssuanceEngine(
                database,
                new BridgeConfig.Ticket(50, 28, 7),
                created::add,
                pending::addAndGet
            );

            issuance.process(new SoopDonation(
                "20221010",
                "phase-f-user",
                "복구테스트",
                105,
                1,
                "phase-f-donation",
                System.currentTimeMillis()
            ));
            require(created.size() == 2, "two tickets must be allocated");
            require(database.countRecoverableTickets() == 2, "two tickets must initially be recoverable");

            // FAILED는 자동 복구 대상에서 제외되는지 확인한다.
            try (var connection = database.open();
                 var statement = connection.prepareStatement(
                     "UPDATE ticket SET status = 'FAILED' WHERE ticket_id = ?"
                 )) {
                statement.setString(1, created.get(1).ticketId());
                statement.executeUpdate();
            }
            require(database.countRecoverableTickets() == 1, "FAILED ticket must not be recoverable");

            var recovery = new TicketRecoveryService(database);
            var beforeRestart = recovery.findPendingIssueEvents();
            require(beforeRestart.size() == 1, "one pending ticket must remain");
            var original = created.getFirst();
            var recovered = beforeRestart.getFirst();
            require(recovered.ticketId().equals(original.ticketId()), "ticket id must survive recovery");
            require(recovered.numbers().equals(original.numbers()), "ticket numbers must survive recovery unchanged");

            recovery.markDispatched(original.ticketId());
            require(readStatus(database, original.ticketId()).equals("ROULETTE_RUNNING"), "dispatch must set ROULETTE_RUNNING");

            // 새 서비스 인스턴스로 재시작을 모사한다.
            var afterRestartService = new TicketRecoveryService(database);
            var afterRestart = afterRestartService.findPendingIssueEvents();
            require(afterRestart.size() == 1, "running ticket must be replayable after restart");
            require(afterRestart.getFirst().numbers().equals(original.numbers()), "replayed numbers must remain identical");

            afterRestartService.markCompleted(original.ticketId());
            require(readStatus(database, original.ticketId()).equals("ROULETTE_COMPLETED"), "completion ack must persist");

            var archive = new TicketArchiveService(
                database,
                root.resolve("tickets"),
                pending::addAndGet
            );
            archive.savePng(original.ticketId(), ONE_PIXEL_PNG);
            require(readStatus(database, original.ticketId()).equals("ISSUED"), "archived recovery ticket must become ISSUED");
            require(afterRestartService.findPendingIssueEvents().isEmpty(), "issued ticket must leave recovery queue");
            require(database.countRecoverableTickets() == 0, "no automatic recovery tickets must remain");

            System.out.println("[phase-f] PASS");
            System.out.println("[phase-f] ticket=" + original.ticketId() + " numbers=" + original.numbers());
            System.out.println("[phase-f] FAILED ticket excluded=" + created.get(1).ticketId());
            return 0;
        } catch (Exception error) {
            System.err.println("[phase-f] FAIL: " + error.getMessage());
            error.printStackTrace(System.err);
            return 1;
        } finally {
            if (root != null) deleteRecursively(root);
        }
    }

    private static String readStatus(BridgeDatabase database, String ticketId) throws Exception {
        try (var connection = database.open();
             var statement = connection.prepareStatement(
                 "SELECT status FROM ticket WHERE ticket_id = ?"
             )) {
            statement.setString(1, ticketId);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) throw new IllegalStateException("ticket missing: " + ticketId);
                return rows.getString(1);
            }
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }

    private static void deleteRecursively(Path root) {
        try (var paths = Files.walk(root)) {
            paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                try { Files.deleteIfExists(path); } catch (Exception ignored) {}
            });
        } catch (Exception ignored) {}
    }
}
