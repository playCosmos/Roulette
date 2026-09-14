package io.github.playcosmos.roulettebridge.recovery;

import com.google.gson.Gson;
import io.github.playcosmos.roulettebridge.db.BridgeDatabase;
import io.github.playcosmos.roulettebridge.issuance.TicketIssueEvent;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.Objects;

public final class TicketRecoveryService {
    private static final Gson GSON = new Gson();

    private final BridgeDatabase database;

    public TicketRecoveryService(BridgeDatabase database) {
        this.database = Objects.requireNonNull(database, "database");
    }

    public synchronized List<TicketIssueEvent> findPendingIssueEvents() throws SQLException {
        var result = new ArrayList<TicketIssueEvent>();
        var sql = """
            SELECT t.ticket_id,
                   t.donor_id,
                   t.nickname_at_issue,
                   t.ticket_sequence,
                   t.numbers_json,
                   t.created_at,
                   d.total_balloons
            FROM ticket t
            JOIN donor d ON d.donor_id = t.donor_id
            WHERE t.status NOT IN ('ISSUED', 'FAILED')
            ORDER BY t.created_at ASC, t.ticket_sequence ASC
            """;

        try (var connection = database.open();
             var statement = connection.prepareStatement(sql);
             var rows = statement.executeQuery()) {
            while (rows.next()) {
                Integer[] values = GSON.fromJson(rows.getString("numbers_json"), Integer[].class);
                if (values == null || values.length == 0) continue;
                result.add(TicketIssueEvent.create(
                    rows.getString("ticket_id"),
                    rows.getString("donor_id"),
                    rows.getString("nickname_at_issue"),
                    rows.getLong("total_balloons"),
                    rows.getInt("ticket_sequence"),
                    List.of(values),
                    rows.getString("created_at")
                ));
            }
        }
        return List.copyOf(result);
    }

    public synchronized void markDispatched(String ticketId) throws SQLException {
        transition(ticketId, "ROULETTE_RUNNING");
    }

    public synchronized void markCompleted(String ticketId) throws SQLException {
        transition(ticketId, "ROULETTE_COMPLETED");
    }

    private void transition(String ticketId, String targetStatus) throws SQLException {
        if (ticketId == null || ticketId.isBlank()) throw new IllegalArgumentException("ticketId is required");
        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                String status;
                try (var statement = connection.prepareStatement(
                    "SELECT status FROM ticket WHERE ticket_id = ?"
                )) {
                    statement.setString(1, ticketId);
                    try (var rows = statement.executeQuery()) {
                        if (!rows.next()) throw new NoSuchElementException("ticket not found: " + ticketId);
                        status = rows.getString(1);
                    }
                }

                if ("ISSUED".equals(status) || "FAILED".equals(status)) {
                    connection.rollback();
                    return;
                }

                try (var statement = connection.prepareStatement("""
                    UPDATE ticket
                    SET status = ?, updated_at = ?
                    WHERE ticket_id = ? AND status NOT IN ('ISSUED', 'FAILED')
                    """)) {
                    statement.setString(1, targetStatus);
                    statement.setString(2, Instant.now().toString());
                    statement.setString(3, ticketId);
                    statement.executeUpdate();
                }
                connection.commit();
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sqlError) throw sqlError;
                if (error instanceof RuntimeException runtime) throw runtime;
                throw new SQLException("ticket state transition failed", error);
            } finally {
                connection.setAutoCommit(true);
            }
        }
    }
}
