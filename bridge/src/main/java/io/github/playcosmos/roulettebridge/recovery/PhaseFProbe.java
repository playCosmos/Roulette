package io.github.playcosmos.roulettebridge.recovery;

import io.github.playcosmos.roulettebridge.config.BridgeConfig;
import io.github.playcosmos.roulettebridge.db.BridgeDatabase;
import io.github.playcosmos.roulettebridge.issuance.DonationIssuanceEngine;
import io.github.playcosmos.roulettebridge.issuance.TicketIssueEvent;
import io.github.playcosmos.roulettebridge.operations.DatabaseBackupService;
import io.github.playcosmos.roulettebridge.operations.FileLog;
import io.github.playcosmos.roulettebridge.operations.ManualAdjustmentService;
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
            var ticketConfig = new BridgeConfig.Ticket(50, 28, 7);

            verifyRecovery(database, root, ticketConfig);
            verifyOperations(database, root, ticketConfig);
            verifyFileLog(root);

            System.out.println("[phase-f] PASS");
            return 0;
        } catch (Exception error) {
            System.err.println("[phase-f] FAIL: " + error.getMessage());
            error.printStackTrace(System.err);
            return 1;
        } finally {
            if (root != null) deleteRecursively(root);
        }
    }

    private static void verifyRecovery(
        BridgeDatabase database,
        Path root,
        BridgeConfig.Ticket ticketConfig
    ) throws Exception {
        var pending = new AtomicInteger();
        var created = new ArrayList<TicketIssueEvent>();
        var issuance = new DonationIssuanceEngine(
            database,
            ticketConfig,
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

        System.out.println("[phase-f] recovery ticket=" + original.ticketId() + " numbers=" + original.numbers());
        System.out.println("[phase-f] FAILED ticket excluded=" + created.get(1).ticketId());
    }

    private static void verifyOperations(
        BridgeDatabase database,
        Path root,
        BridgeConfig.Ticket ticketConfig
    ) throws Exception {
        var pending = new AtomicInteger();
        var emitted = new ArrayList<TicketIssueEvent>();
        var adjustment = new ManualAdjustmentService(
            database,
            ticketConfig,
            emitted::add,
            pending::addAndGet
        );
        var archive = new TicketArchiveService(
            database,
            root.resolve("tickets"),
            pending::addAndGet
        );

        var plus55 = adjustment.adjust("phase-f-ops", "첫닉", 55, "probe +55");
        require(plus55.totalBalloons() == 55, "manual +55 total mismatch");
        require(plus55.newTickets().size() == 1, "manual +55 must allocate one ticket");
        var firstTicket = plus55.newTickets().getFirst();
        var firstSave = archive.savePng(firstTicket.ticketId(), ONE_PIXEL_PNG);

        var minus5 = adjustment.adjust("phase-f-ops", "첫닉", -5, "probe -5");
        require(minus5.totalBalloons() == 50, "manual -5 total mismatch");
        require(minus5.newTickets().isEmpty(), "manual -5 must not allocate a ticket");

        boolean rejected = false;
        try {
            adjustment.adjust("phase-f-ops", "첫닉", -1, "must reject allocated-right revocation");
        } catch (IllegalArgumentException expected) {
            rejected = true;
        }
        require(rejected, "adjustment below allocated entitlement must be rejected");

        var plus50 = adjustment.adjust("phase-f-ops", "둘닉", 50, "probe nickname change +50");
        require(plus50.totalBalloons() == 100, "nickname-change total mismatch");
        require(plus50.newTickets().size() == 1, "second nickname must allocate second ticket");
        var secondTicket = plus50.newTickets().getFirst();
        var secondSave = archive.savePng(secondTicket.ticketId(), ONE_PIXEL_PNG);

        int rebuilt = archive.rebuildAllManifests();
        require(rebuilt >= 2, "manifest rebuild must include nickname groups");
        String firstManifest = Files.readString(root.resolve("tickets").resolve(firstSave.manifestPath()));
        String secondManifest = Files.readString(root.resolve("tickets").resolve(secondSave.manifestPath()));
        require(firstManifest.contains(firstTicket.ticketId()), "first nickname manifest must contain first ticket");
        require(!firstManifest.contains(secondTicket.ticketId()), "first nickname manifest must not contain second nickname ticket");
        require(secondManifest.contains(secondTicket.ticketId()), "second nickname manifest must contain second ticket");
        require(!secondManifest.contains(firstTicket.ticketId()), "second nickname manifest must not contain first nickname ticket");

        try (var connection = database.open();
             var statement = connection.prepareStatement(
                 "SELECT COUNT(*) FROM adjustment_event WHERE donor_id = ?"
             )) {
            statement.setString(1, "phase-f-ops");
            try (var rows = statement.executeQuery()) {
                require(rows.next() && rows.getInt(1) == 3, "only committed adjustments must be audited");
            }
        }

        var backup = new DatabaseBackupService(database, root.resolve("backups"));
        Path backupPath = backup.createBackup();
        require(Files.isRegularFile(backupPath) && Files.size(backupPath) > 0, "backup file must exist");
        var backupDb = new BridgeDatabase(backupPath);
        backupDb.initialize();
        try (var connection = backupDb.open();
             var statement = connection.prepareStatement(
                 "SELECT total_balloons FROM donor WHERE donor_id = ?"
             )) {
            statement.setString(1, "phase-f-ops");
            try (var rows = statement.executeQuery()) {
                require(rows.next() && rows.getLong(1) == 100, "backup must contain committed donor state");
            }
        }

        System.out.println("[phase-f] operations backup=" + backupPath.getFileName());
        System.out.println("[phase-f] nickname manifests separated and rebuilt");
    }

    private static void verifyFileLog(Path root) throws Exception {
        var log = FileLog.install(root.resolve("logs"));
        Path path = log.path();
        String marker = "[phase-f] file-log-marker";
        System.out.println(marker);
        log.close();
        require(Files.readString(path).contains(marker), "persistent file log must contain marker");
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
