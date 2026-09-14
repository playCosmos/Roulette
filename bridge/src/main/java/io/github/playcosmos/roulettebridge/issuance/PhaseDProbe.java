package io.github.playcosmos.roulettebridge.issuance;

import io.github.playcosmos.roulettebridge.config.BridgeConfig;
import io.github.playcosmos.roulettebridge.db.BridgeDatabase;
import io.github.playcosmos.roulettebridge.soop.SoopDonation;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.concurrent.atomic.AtomicInteger;

public final class PhaseDProbe {
    private PhaseDProbe() {}

    public static int run() {
        try {
            var directory = Files.createTempDirectory("roulette-phase-d-");
            var database = new BridgeDatabase(directory.resolve("roulette.db"));
            database.initialize();

            var emitted = new ArrayList<TicketIssueEvent>();
            var pending = new AtomicInteger();
            var engine = new DonationIssuanceEngine(
                database,
                new BridgeConfig.Ticket(50, 28, 7),
                emitted::add,
                pending::addAndGet
            );

            long base = System.currentTimeMillis();
            var first = engine.process(new SoopDonation(
                "20221010", "donor-a", "테스트후원자", 30, 1, "raw-30", base
            ));
            require(!first.duplicate(), "first donation must be accepted");
            require(first.totalBalloons() == 30, "30 balloons total expected");
            require(first.newTicketCount() == 0, "30 balloons must not issue a ticket");
            require(first.remainderBalloons() == 30, "remainder must be 30");

            var secondDonation = new SoopDonation(
                "20221010", "donor-a", "테스트후원자", 25, 2, "raw-25", base + 1_000
            );
            var second = engine.process(secondDonation);
            require(second.totalBalloons() == 55, "55 balloons total expected");
            require(second.newTicketCount() == 1, "55 total must issue one ticket");
            require(second.allocatedTicketCount() == 1, "one allocated ticket expected");
            require(second.remainderBalloons() == 5, "remainder must be 5");

            var replay = engine.process(new SoopDonation(
                "20221010", "donor-a", "테스트후원자", 25, 2, "raw-25", base + 2_000
            ));
            require(replay.duplicate(), "replayed donation must be deduplicated");
            require(replay.totalBalloons() == 55, "duplicate must not change total");
            require(replay.newTicketCount() == 0, "duplicate must not issue ticket");

            var third = engine.process(new SoopDonation(
                "20221010", "donor-a", "테스트후원자", 120, 3, "raw-120", base + 3_000
            ));
            require(third.totalBalloons() == 175, "175 balloons total expected");
            require(third.newTicketCount() == 2, "120 additional balloons must issue two more tickets");
            require(third.allocatedTicketCount() == 3, "three allocated tickets expected");
            require(third.remainderBalloons() == 25, "remainder must be 25");

            require(emitted.size() == 3, "exactly three overlay events expected");
            require(pending.get() == 3, "three pending tickets expected");
            for (int i = 0; i < emitted.size(); i++) {
                var ticket = emitted.get(i);
                require(ticket.ticketNumber() == i + 1, "ticket sequence must be stable");
                require(ticket.numbers().size() == 7, "ticket must have seven numbers");
                require(new HashSet<>(ticket.numbers()).size() == 7, "ticket numbers must be unique");
                require(ticket.numbers().stream().allMatch(n -> n >= 1 && n <= 28), "ticket number out of range");
            }

            var recoverable = database.findRecoverableTickets();
            require(recoverable.size() == 3, "three recoverable NUMBERS_CONFIRMED tickets expected");
            require(recoverable.stream().allMatch(t -> "NUMBERS_CONFIRMED".equals(t.status())),
                "all generated tickets must be NUMBERS_CONFIRMED");

            System.out.println("[phase-d] PASS");
            System.out.println("[phase-d] total=175 allocated=3 remainder=25 duplicate=ignored");
            emitted.forEach(ticket -> System.out.println(
                "[phase-d] #" + ticket.ticketNumber() + " " + ticket.nickname() + " " + ticket.numbers()
            ));
            return 0;
        } catch (Exception error) {
            error.printStackTrace(System.err);
            System.err.println("[phase-d] FAIL: " + error.getMessage());
            return 1;
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }
}
