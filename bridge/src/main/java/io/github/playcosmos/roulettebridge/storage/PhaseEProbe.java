package io.github.playcosmos.roulettebridge.storage;

import io.github.playcosmos.roulettebridge.config.BridgeConfig;
import io.github.playcosmos.roulettebridge.db.BridgeDatabase;
import io.github.playcosmos.roulettebridge.issuance.DonationIssuanceEngine;
import io.github.playcosmos.roulettebridge.issuance.TicketIssueEvent;
import io.github.playcosmos.roulettebridge.soop.SoopDonation;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.concurrent.atomic.AtomicInteger;

public final class PhaseEProbe {
    private static final byte[] ONE_PIXEL_PNG = Base64.getDecoder().decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0n0AAAAASUVORK5CYII="
    );

    private PhaseEProbe() {}

    public static int run() {
        Path root = null;
        try {
            root = Files.createTempDirectory("roulette-phase-e-");
            var database = new BridgeDatabase(root.resolve("data/roulette.db"));
            database.initialize();

            var pending = new AtomicInteger();
            var tickets = new ArrayList<TicketIssueEvent>();
            var ticketConfig = new BridgeConfig.Ticket(50, 28, 7);
            var issuance = new DonationIssuanceEngine(
                database,
                ticketConfig,
                tickets::add,
                pending::addAndGet
            );

            issuance.process(new SoopDonation(
                "20221010",
                "phase-e-user",
                "저장테스트",
                55,
                1,
                "phase-e-donation",
                System.currentTimeMillis()
            ));

            require(tickets.size() == 1, "one ticket must be allocated");
            require(pending.get() == 1, "pending count must be one before archive");

            var archive = new TicketArchiveService(
                database,
                root.resolve("tickets"),
                pending::addAndGet
            );
            var ticket = tickets.getFirst();
            var first = archive.savePng(ticket.ticketId(), ONE_PIXEL_PNG);

            require("ISSUED".equals(first.status()), "ticket must be ISSUED");
            require(first.issuedNow(), "first save must finalize ticket");
            require(pending.get() == 0, "pending count must decrement after archive");
            require(Files.isRegularFile(root.resolve("tickets").resolve(first.imagePath())), "PNG must exist");
            require(Files.isRegularFile(root.resolve("tickets").resolve(first.manifestPath())), "issued.json must exist");

            try (var connection = database.open()) {
                try (var statement = connection.prepareStatement(
                    "SELECT status, image_path FROM ticket WHERE ticket_id = ?"
                )) {
                    statement.setString(1, ticket.ticketId());
                    try (var rows = statement.executeQuery()) {
                        require(rows.next(), "ticket row must exist");
                        require("ISSUED".equals(rows.getString("status")), "database ticket status must be ISSUED");
                        require(first.imagePath().equals(rows.getString("image_path")), "database image path must match archive");
                    }
                }

                try (var statement = connection.prepareStatement(
                    "SELECT issued_ticket_count FROM donor WHERE donor_id = ?"
                )) {
                    statement.setString(1, ticket.donorId());
                    try (var rows = statement.executeQuery()) {
                        require(rows.next(), "donor row must exist");
                        require(rows.getInt(1) == 1, "donor issued count must be one");
                    }
                }
            }

            var second = archive.savePng(ticket.ticketId(), ONE_PIXEL_PNG);
            require(!second.issuedNow(), "repeated upload must be idempotent");
            require(pending.get() == 0, "repeated upload must not decrement pending twice");

            try (var connection = database.open();
                 var statement = connection.prepareStatement(
                     "SELECT issued_ticket_count FROM donor WHERE donor_id = ?"
                 )) {
                statement.setString(1, ticket.donorId());
                try (var rows = statement.executeQuery()) {
                    require(rows.next() && rows.getInt(1) == 1, "repeated upload must not increment issued count twice");
                }
            }

            String manifest = Files.readString(root.resolve("tickets").resolve(first.manifestPath()));
            require(manifest.contains(ticket.ticketId()), "manifest must contain ticket id");
            require(manifest.contains("저장테스트"), "manifest must contain nickname");

            System.out.println("[phase-e] PASS");
            System.out.println("[phase-e] image=" + first.imagePath());
            System.out.println("[phase-e] manifest=" + first.manifestPath());
            return 0;
        } catch (Exception error) {
            System.err.println("[phase-e] FAIL: " + error.getMessage());
            error.printStackTrace(System.err);
            return 1;
        } finally {
            if (root != null) deleteRecursively(root);
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
