package io.github.playcosmos.roulettebridge.issuance;

import com.google.gson.Gson;
import io.github.playcosmos.roulettebridge.config.BridgeConfig;
import io.github.playcosmos.roulettebridge.db.BridgeDatabase;
import io.github.playcosmos.roulettebridge.soop.SoopDonation;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.function.IntConsumer;

public final class DonationIssuanceEngine {
    private static final Gson GSON = new Gson();
    private static final long DEDUP_WINDOW_SECONDS = 30;

    private final BridgeDatabase database;
    private final BridgeConfig.Ticket ticketConfig;
    private final TicketNumberGenerator numberGenerator;
    private final Consumer<TicketIssueEvent> ticketSink;
    private final IntConsumer pendingTicketDelta;

    public DonationIssuanceEngine(
        BridgeDatabase database,
        BridgeConfig.Ticket ticketConfig,
        Consumer<TicketIssueEvent> ticketSink,
        IntConsumer pendingTicketDelta
    ) {
        this.database = Objects.requireNonNull(database, "database");
        this.ticketConfig = Objects.requireNonNull(ticketConfig, "ticketConfig");
        this.ticketSink = Objects.requireNonNull(ticketSink, "ticketSink");
        this.pendingTicketDelta = Objects.requireNonNull(pendingTicketDelta, "pendingTicketDelta");
        this.numberGenerator = new TicketNumberGenerator();
    }

    public synchronized DonationResult process(SoopDonation donation) throws SQLException {
        validateDonation(donation);

        var receivedAt = donation.receivedAtEpochMs() > 0
            ? Instant.ofEpochMilli(donation.receivedAtEpochMs())
            : Instant.now();
        var receivedAtText = receivedAt.toString();
        var rawHash = rawHash(donation);
        var createdTickets = new ArrayList<TicketIssueEvent>();
        DonationResult result;

        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                var duplicateEventId = findRecentDuplicate(
                    connection,
                    donation.donorId(),
                    rawHash,
                    receivedAt.minusSeconds(DEDUP_WINDOW_SECONDS).toString()
                );

                if (duplicateEventId != null) {
                    long total = readDonorTotal(connection, donation.donorId());
                    int allocated = countAllocatedTickets(connection, donation.donorId());
                    connection.rollback();
                    return new DonationResult(
                        true,
                        duplicateEventId,
                        total,
                        allocated,
                        0,
                        remainder(total, allocated),
                        List.of()
                    );
                }

                String eventId = createEventId(receivedAt);
                upsertDonor(connection, donation, receivedAtText);
                insertDonationEvent(connection, eventId, donation, receivedAtText, rawHash);

                long totalBalloons = readDonorTotal(connection, donation.donorId());
                int allocatedBefore = countAllocatedTickets(connection, donation.donorId());
                int newTicketCount = calculateNewTicketCount(donation, totalBalloons, allocatedBefore);

                for (int i = 0; i < newTicketCount; i++) {
                    int ticketSequence = allocatedBefore + i + 1;
                    var numbers = numberGenerator.generate(ticketConfig.numberMax(), ticketConfig.numberCount());
                    var ticketId = createTicketId(receivedAt, ticketSequence);
                    insertTicket(
                        connection,
                        ticketId,
                        donation.donorId(),
                        donation.nickname(),
                        ticketSequence,
                        numbers,
                        eventId,
                        receivedAtText
                    );
                    createdTickets.add(TicketIssueEvent.create(
                        ticketId,
                        donation.donorId(),
                        donation.nickname(),
                        totalBalloons,
                        ticketSequence,
                        numbers,
                        receivedAtText
                    ));
                }

                markDonationProcessed(connection, eventId, Instant.now().toString());
                connection.commit();

                int allocatedAfter = allocatedBefore + newTicketCount;
                result = new DonationResult(
                    false,
                    eventId,
                    totalBalloons,
                    allocatedAfter,
                    newTicketCount,
                    remainder(totalBalloons, allocatedAfter),
                    List.copyOf(createdTickets)
                );
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sqlError) throw sqlError;
                throw new SQLException("failed to process donation", error);
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
                    System.err.println("[issuance] overlay dispatch failed for " + ticket.ticketId() + ": " + error.getMessage());
                }
            }
        }

        return result;
    }

    private int calculateNewTicketCount(SoopDonation donation, long totalBalloons, int allocatedBefore) throws SQLException {
        long eligibleLong;
        if (ticketConfig.singleDonationMode()) {
            eligibleLong = donation.balloonCount() / (long) ticketConfig.balloonsPerTicket();
        } else {
            eligibleLong = totalBalloons / ticketConfig.balloonsPerTicket();
            eligibleLong = Math.max(0L, eligibleLong - allocatedBefore);
        }
        if (eligibleLong > Integer.MAX_VALUE) {
            throw new SQLException("eligible ticket count exceeds supported range: " + eligibleLong);
        }
        return (int) eligibleLong;
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

    private static void validateDonation(SoopDonation donation) {
        Objects.requireNonNull(donation, "donation");
        if (donation.donorId() == null || donation.donorId().isBlank()) {
            throw new IllegalArgumentException("donorId is required");
        }
        if (donation.balloonCount() <= 0) {
            throw new IllegalArgumentException("balloonCount must be positive");
        }
    }

    private static String findRecentDuplicate(
        Connection connection,
        String donorId,
        String rawHash,
        String cutoff
    ) throws SQLException {
        var sql = """
            SELECT event_id
            FROM donation_event
            WHERE donor_id = ? AND raw_hash = ? AND received_at >= ?
            ORDER BY received_at DESC
            LIMIT 1
            """;
        try (var statement = connection.prepareStatement(sql)) {
            statement.setString(1, donorId);
            statement.setString(2, rawHash);
            statement.setString(3, cutoff);
            try (var rows = statement.executeQuery()) {
                return rows.next() ? rows.getString(1) : null;
            }
        }
    }

    private static void upsertDonor(Connection connection, SoopDonation donation, String now) throws SQLException {
        var sql = """
            INSERT INTO donor (
                donor_id, current_nickname, total_balloons, issued_ticket_count, created_at, updated_at
            ) VALUES (?, ?, ?, 0, ?, ?)
            ON CONFLICT(donor_id) DO UPDATE SET
                current_nickname = excluded.current_nickname,
                total_balloons = donor.total_balloons + excluded.total_balloons,
                updated_at = excluded.updated_at
            """;
        try (var statement = connection.prepareStatement(sql)) {
            statement.setString(1, donation.donorId());
            statement.setString(2, normalizedNickname(donation.nickname()));
            statement.setInt(3, donation.balloonCount());
            statement.setString(4, now);
            statement.setString(5, now);
            statement.executeUpdate();
        }
    }

    private static void insertDonationEvent(
        Connection connection,
        String eventId,
        SoopDonation donation,
        String receivedAt,
        String rawHash
    ) throws SQLException {
        var sql = """
            INSERT INTO donation_event (
                event_id, donor_id, nickname, balloon_count, received_at, processed_at, raw_payload, raw_hash
            ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
            """;
        try (var statement = connection.prepareStatement(sql)) {
            statement.setString(1, eventId);
            statement.setString(2, donation.donorId());
            statement.setString(3, normalizedNickname(donation.nickname()));
            statement.setInt(4, donation.balloonCount());
            statement.setString(5, receivedAt);
            statement.setString(6, donation.rawPayload());
            statement.setString(7, rawHash);
            statement.executeUpdate();
        }
    }

    private static void insertTicket(
        Connection connection,
        String ticketId,
        String donorId,
        String nickname,
        int ticketSequence,
        List<Integer> numbers,
        String sourceEventId,
        String createdAt
    ) throws SQLException {
        var sql = """
            INSERT INTO ticket (
                ticket_id, donor_id, nickname_at_issue, ticket_sequence, numbers_json,
                status, image_path, source_event_id, created_at, updated_at, issued_at
            ) VALUES (?, ?, ?, ?, ?, 'NUMBERS_CONFIRMED', NULL, ?, ?, ?, NULL)
            """;
        try (var statement = connection.prepareStatement(sql)) {
            statement.setString(1, ticketId);
            statement.setString(2, donorId);
            statement.setString(3, normalizedNickname(nickname));
            statement.setInt(4, ticketSequence);
            statement.setString(5, GSON.toJson(numbers));
            statement.setString(6, sourceEventId);
            statement.setString(7, createdAt);
            statement.setString(8, createdAt);
            statement.executeUpdate();
        }
    }

    private static long readDonorTotal(Connection connection, String donorId) throws SQLException {
        try (var statement = connection.prepareStatement(
            "SELECT total_balloons FROM donor WHERE donor_id = ?"
        )) {
            statement.setString(1, donorId);
            try (var rows = statement.executeQuery()) {
                return rows.next() ? rows.getLong(1) : 0L;
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

    private static void markDonationProcessed(Connection connection, String eventId, String processedAt) throws SQLException {
        try (var statement = connection.prepareStatement(
            "UPDATE donation_event SET processed_at = ? WHERE event_id = ?"
        )) {
            statement.setString(1, processedAt);
            statement.setString(2, eventId);
            statement.executeUpdate();
        }
    }

    private static String rawHash(SoopDonation donation) throws SQLException {
        try {
            String raw = donation.rawPayload();
            String material = donation.streamerId() + "\u0000"
                + donation.donorId() + "\u0000"
                + donation.balloonCount() + "\u0000"
                + donation.fanOrder() + "\u0000"
                + (raw == null ? "" : raw);
            var digest = MessageDigest.getInstance("SHA-256").digest(material.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (Exception error) {
            throw new SQLException("failed to calculate donation fingerprint", error);
        }
    }

    private static String createEventId(Instant instant) {
        return "D" + instant.toEpochMilli() + "-" + shortUuid();
    }

    private static String createTicketId(Instant instant, int sequence) {
        return "T" + instant.toEpochMilli() + "-" + sequence + "-" + shortUuid();
    }

    private static String shortUuid() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 8);
    }

    private static String normalizedNickname(String nickname) {
        if (nickname == null || nickname.isBlank()) return "익명";
        var value = nickname.trim();
        return value.length() <= 80 ? value : value.substring(0, 80);
    }

    public record DonationResult(
        boolean duplicate,
        String eventId,
        long totalBalloons,
        int allocatedTicketCount,
        int newTicketCount,
        int remainderBalloons,
        List<TicketIssueEvent> tickets
    ) {}
}
