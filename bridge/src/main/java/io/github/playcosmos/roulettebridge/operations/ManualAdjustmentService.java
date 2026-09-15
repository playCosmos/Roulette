package io.github.playcosmos.roulettebridge.operations;

import com.google.gson.Gson;
import io.github.playcosmos.roulettebridge.config.BridgeConfig;
import io.github.playcosmos.roulettebridge.db.BridgeDatabase;
import io.github.playcosmos.roulettebridge.issuance.TicketIssueEvent;
import io.github.playcosmos.roulettebridge.issuance.TicketNumberGenerator;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.function.IntConsumer;

public final class ManualAdjustmentService {
    private static final Gson GSON = new Gson();

    private final BridgeDatabase database;
    private final BridgeConfig.Ticket ticketConfig;
    private final TicketNumberGenerator numberGenerator = new TicketNumberGenerator();
    private final Consumer<TicketIssueEvent> ticketSink;
    private final IntConsumer pendingTicketDelta;

    public ManualAdjustmentService(
        BridgeDatabase database,
        BridgeConfig.Ticket ticketConfig,
        Consumer<TicketIssueEvent> ticketSink,
        IntConsumer pendingTicketDelta
    ) {
        this.database = Objects.requireNonNull(database, "database");
        this.ticketConfig = Objects.requireNonNull(ticketConfig, "ticketConfig");
        this.ticketSink = Objects.requireNonNull(ticketSink, "ticketSink");
        this.pendingTicketDelta = Objects.requireNonNull(pendingTicketDelta, "pendingTicketDelta");
    }

    public synchronized AdjustmentResult adjust(
        String donorId,
        String nickname,
        int balloonDelta,
        String reason
    ) throws SQLException {
        donorId = required(donorId, "donorId", 120);
        nickname = normalizedNickname(nickname);
        reason = required(reason, "reason", 500);
        if (balloonDelta == 0) throw new IllegalArgumentException("balloonDelta must not be zero");

        var createdTickets = new ArrayList<TicketIssueEvent>();
        long newTotal;
        int allocatedAfter;
        String adjustmentId = "A" + Instant.now().toEpochMilli() + "-" + shortUuid();
        String now = Instant.now().toString();

        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                var state = readDonorState(connection, donorId);
                long oldTotal = state == null ? 0L : state.totalBalloons();
                int allocatedBefore = countAllocatedTickets(connection, donorId);
                newTotal = Math.addExact(oldTotal, balloonDelta);
                if (newTotal < 0) {
                    throw new IllegalArgumentException("adjustment would make total balloons negative");
                }
                long minimumCommitted = (long) allocatedBefore * ticketConfig.balloonsPerTicket();
                if (newTotal < minimumCommitted) {
                    throw new IllegalArgumentException(
                        "adjustment would revoke already allocated tickets; minimum total is " + minimumCommitted
                    );
                }

                upsertDonor(connection, donorId, nickname, newTotal, now);
                insertAdjustment(connection, adjustmentId, donorId, nickname, balloonDelta, reason, now);

                int newTicketCount = 0;
                if (ticketConfig.cumulativeMode()) {
                    long eligibleLong = newTotal / ticketConfig.balloonsPerTicket();
                    if (eligibleLong > Integer.MAX_VALUE) throw new SQLException("eligible ticket count exceeds supported range");
                    int eligible = (int) eligibleLong;
                    newTicketCount = Math.max(0, eligible - allocatedBefore);
                }

                for (int index = 0; index < newTicketCount; index++) {
                    int sequence = allocatedBefore + index + 1;
                    var numbers = numberGenerator.generate(ticketConfig.numberMax(), ticketConfig.numberCount());
                    String ticketId = "T" + Instant.now().toEpochMilli() + "-" + sequence + "-" + shortUuid();
                    insertTicket(connection, ticketId, donorId, nickname, sequence, numbers, now);
                    createdTickets.add(TicketIssueEvent.create(
                        ticketId,
                        donorId,
                        nickname,
                        newTotal,
                        sequence,
                        numbers,
                        now
                    ));
                }

                allocatedAfter = allocatedBefore + newTicketCount;
                connection.commit();
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sqlError) throw sqlError;
                if (error instanceof RuntimeException runtime) throw runtime;
                throw new SQLException("manual adjustment failed", error);
            } finally {
                connection.setAutoCommit(true);
            }
        }

        if (!createdTickets.isEmpty()) {
            pendingTicketDelta.accept(createdTickets.size());
            for (var ticket : createdTickets) {
                try {
                    ticketSink.accept(ticket);
                } catch (RuntimeException error) {
                    System.err.println("[adjustment] overlay dispatch failed for " + ticket.ticketId() + ": " + error.getMessage());
                }
            }
        }

        return new AdjustmentResult(
            adjustmentId,
            donorId,
            nickname,
            balloonDelta,
            newTotal,
            allocatedAfter,
            remainder(newTotal, allocatedAfter),
            List.copyOf(createdTickets)
        );
    }

    private int remainder(long totalBalloons, int allocatedTickets) {
        if (ticketConfig.singleDonationMode()) {
            long countedOnly = Math.max(
                0L,
                totalBalloons - (long) allocatedTickets * ticketConfig.balloonsPerTicket()
            );
            return countedOnly > Integer.MAX_VALUE ? Integer.MAX_VALUE : (int) countedOnly;
        }
        return (int) (totalBalloons % ticketConfig.balloonsPerTicket());
    }

    private static DonorState readDonorState(Connection connection, String donorId) throws SQLException {
        try (var statement = connection.prepareStatement(
            "SELECT total_balloons FROM donor WHERE donor_id = ?"
        )) {
            statement.setString(1, donorId);
            try (var rows = statement.executeQuery()) {
                return rows.next() ? new DonorState(rows.getLong(1)) : null;
            }
        }
    }

    private static int countAllocatedTickets(Connection connection, String donorId) throws SQLException {
        try (var statement = connection.prepareStatement(
            "SELECT COUNT(*) FROM ticket WHERE donor_id = ?"
        )) {
            statement.setString(1, donorId);
            try (var rows = statement.executeQuery()) {
                return rows.next() ? rows.getInt(1) : 0;
            }
        }
    }

    private static void upsertDonor(
        Connection connection,
        String donorId,
        String nickname,
        long newTotal,
        String now
    ) throws SQLException {
        try (var statement = connection.prepareStatement("""
            INSERT INTO donor (
                donor_id, current_nickname, total_balloons, issued_ticket_count, created_at, updated_at
            ) VALUES (?, ?, ?, 0, ?, ?)
            ON CONFLICT(donor_id) DO UPDATE SET
                current_nickname = excluded.current_nickname,
                total_balloons = excluded.total_balloons,
                updated_at = excluded.updated_at
            """)) {
            statement.setString(1, donorId);
            statement.setString(2, nickname);
            statement.setLong(3, newTotal);
            statement.setString(4, now);
            statement.setString(5, now);
            statement.executeUpdate();
        }
    }

    private static void insertAdjustment(
        Connection connection,
        String adjustmentId,
        String donorId,
        String nickname,
        int delta,
        String reason,
        String now
    ) throws SQLException {
        try (var statement = connection.prepareStatement("""
            INSERT INTO adjustment_event (
                adjustment_id, donor_id, nickname, balloon_delta, reason, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """)) {
            statement.setString(1, adjustmentId);
            statement.setString(2, donorId);
            statement.setString(3, nickname);
            statement.setInt(4, delta);
            statement.setString(5, reason);
            statement.setString(6, now);
            statement.executeUpdate();
        }
    }

    private static void insertTicket(
        Connection connection,
        String ticketId,
        String donorId,
        String nickname,
        int sequence,
        List<Integer> numbers,
        String now
    ) throws SQLException {
        try (var statement = connection.prepareStatement("""
            INSERT INTO ticket (
                ticket_id, donor_id, nickname_at_issue, ticket_sequence, numbers_json,
                status, image_path, source_event_id, created_at, updated_at, issued_at
            ) VALUES (?, ?, ?, ?, ?, 'NUMBERS_CONFIRMED', NULL, NULL, ?, ?, NULL)
            """)) {
            statement.setString(1, ticketId);
            statement.setString(2, donorId);
            statement.setString(3, nickname);
            statement.setInt(4, sequence);
            statement.setString(5, GSON.toJson(numbers));
            statement.setString(6, now);
            statement.setString(7, now);
            statement.executeUpdate();
        }
    }

    private static String normalizedNickname(String nickname) {
        if (nickname == null || nickname.isBlank()) return "익명";
        String value = nickname.trim();
        return value.length() <= 80 ? value : value.substring(0, 80);
    }

    private static String required(String value, String name, int maxLength) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
        String trimmed = value.trim();
        return trimmed.length() <= maxLength ? trimmed : trimmed.substring(0, maxLength);
    }

    private static String shortUuid() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 8);
    }

    private record DonorState(long totalBalloons) {}

    public record AdjustmentResult(
        String adjustmentId,
        String donorId,
        String nickname,
        int balloonDelta,
        long totalBalloons,
        int allocatedTicketCount,
        int remainderBalloons,
        List<TicketIssueEvent> newTickets
    ) {}
}
