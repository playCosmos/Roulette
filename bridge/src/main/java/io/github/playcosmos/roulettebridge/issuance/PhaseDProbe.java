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
            require(BridgeConfig.defaults().ticket().singleDonationMode(),
                "single donation issuance must be the default mode");
            runSingleDonationMode();
            runCumulativeMode();
            System.out.println("[phase-d] PASS");
            return 0;
        } catch (Exception error) {
            error.printStackTrace(System.err);
            System.err.println("[phase-d] FAIL: " + error.getMessage());
            return 1;
        }
    }

    private static void runSingleDonationMode() throws Exception {
        var directory = Files.createTempDirectory("roulette-phase-d-single-");
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
            "20221010", "donor-single", "단일후원자", 30, 1, "single-30", base
        ));
        require(first.totalBalloons() == 30, "single: total 30 expected");
        require(first.newTicketCount() == 0, "single: 30 must not issue a ticket");
        require(first.remainderBalloons() == 30, "single: count-only remainder must be 30");

        var secondDonation = new SoopDonation(
            "20221010", "donor-single", "단일후원자", 25, 2, "single-25", base + 1_000
        );
        var second = engine.process(secondDonation);
        require(second.totalBalloons() == 55, "single: lifetime total 55 expected");
        require(second.newTicketCount() == 0, "single: 30+25 must not combine into a ticket");
        require(second.allocatedTicketCount() == 0, "single: no ticket must be allocated from sub-threshold donations");
        require(second.remainderBalloons() == 55, "single: count-only remainder may exceed the threshold");

        var replay = engine.process(new SoopDonation(
            "20221010", "donor-single", "단일후원자", 25, 2, "single-25", base + 2_000
        ));
        require(replay.duplicate(), "single: replayed donation must be deduplicated");
        require(replay.totalBalloons() == 55, "single: duplicate must not change total");
        require(replay.remainderBalloons() == 55, "single: duplicate must preserve count-only remainder");

        var third = engine.process(new SoopDonation(
            "20221010", "donor-single", "단일후원자", 120, 3, "single-120", base + 3_000
        ));
        require(third.totalBalloons() == 175, "single: lifetime total 175 expected");
        require(third.newTicketCount() == 2, "single: one 120 donation must issue two tickets");
        require(third.allocatedTicketCount() == 2, "single: two allocated tickets expected");
        require(third.remainderBalloons() == 75, "single: previous sub-threshold amounts plus 20 must remain count-only");

        var fourth = engine.process(new SoopDonation(
            "20221010", "donor-single", "단일후원자", 50, 4, "single-50", base + 4_000
        ));
        require(fourth.newTicketCount() == 1, "single: exactly 50 must issue one ticket");
        require(fourth.allocatedTicketCount() == 3, "single: three allocated tickets expected");
        require(fourth.remainderBalloons() == 75, "single: count-only remainder must not be consumed later");

        verifyGeneratedTickets(database, emitted, pending, 3, "single");
        System.out.println("[phase-d] single_donation total=225 allocated=3 countOnly=75");
    }

    private static void runCumulativeMode() throws Exception {
        var directory = Files.createTempDirectory("roulette-phase-d-cumulative-");
        var database = new BridgeDatabase(directory.resolve("roulette.db"));
        database.initialize();

        var emitted = new ArrayList<TicketIssueEvent>();
        var pending = new AtomicInteger();
        var engine = new DonationIssuanceEngine(
            database,
            new BridgeConfig.Ticket(50, 28, 7, BridgeConfig.Ticket.MODE_CUMULATIVE),
            emitted::add,
            pending::addAndGet
        );

        long base = System.currentTimeMillis();
        var first = engine.process(new SoopDonation(
            "20221010", "donor-cumulative", "누적후원자", 30, 1, "cumulative-30", base
        ));
        require(first.newTicketCount() == 0, "cumulative: 30 must not issue a ticket");
        require(first.remainderBalloons() == 30, "cumulative: remainder must be 30");

        var second = engine.process(new SoopDonation(
            "20221010", "donor-cumulative", "누적후원자", 25, 2, "cumulative-25", base + 1_000
        ));
        require(second.totalBalloons() == 55, "cumulative: total 55 expected");
        require(second.newTicketCount() == 1, "cumulative: 30+25 must issue one ticket");
        require(second.remainderBalloons() == 5, "cumulative: remainder must be 5");

        var third = engine.process(new SoopDonation(
            "20221010", "donor-cumulative", "누적후원자", 120, 3, "cumulative-120", base + 3_000
        ));
        require(third.totalBalloons() == 175, "cumulative: total 175 expected");
        require(third.newTicketCount() == 2, "cumulative: 120 additional balloons must issue two tickets");
        require(third.allocatedTicketCount() == 3, "cumulative: three allocated tickets expected");
        require(third.remainderBalloons() == 25, "cumulative: remainder must be 25");

        verifyGeneratedTickets(database, emitted, pending, 3, "cumulative");
        System.out.println("[phase-d] cumulative total=175 allocated=3 remainder=25");
    }

    private static void verifyGeneratedTickets(
        BridgeDatabase database,
        ArrayList<TicketIssueEvent> emitted,
        AtomicInteger pending,
        int expected,
        String label
    ) throws Exception {
        require(emitted.size() == expected, label + ": overlay event count mismatch");
        require(pending.get() == expected, label + ": pending ticket count mismatch");
        for (int i = 0; i < emitted.size(); i++) {
            var ticket = emitted.get(i);
            require(ticket.ticketNumber() == i + 1, label + ": ticket sequence must be stable");
            require(ticket.numbers().size() == 7, label + ": ticket must have seven numbers");
            require(new HashSet<>(ticket.numbers()).size() == 7, label + ": ticket numbers must be unique");
            require(ticket.numbers().stream().allMatch(n -> n >= 1 && n <= 28), label + ": ticket number out of range");
        }

        var recoverable = database.findRecoverableTickets();
        require(recoverable.size() == expected, label + ": recoverable ticket count mismatch");
        require(recoverable.stream().allMatch(t -> "NUMBERS_CONFIRMED".equals(t.status())),
            label + ": all generated tickets must be NUMBERS_CONFIRMED");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }
}
