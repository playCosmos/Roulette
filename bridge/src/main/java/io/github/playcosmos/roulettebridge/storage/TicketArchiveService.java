package io.github.playcosmos.roulettebridge.storage;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import io.github.playcosmos.roulettebridge.db.BridgeDatabase;
import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.Objects;
import java.util.function.IntConsumer;

public final class TicketArchiveService {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final byte[] PNG_SIGNATURE = new byte[] {
        (byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
    };

    private final BridgeDatabase database;
    private final Path ticketRoot;
    private final IntConsumer pendingTicketDelta;

    public TicketArchiveService(
        BridgeDatabase database,
        Path ticketRoot,
        IntConsumer pendingTicketDelta
    ) throws IOException {
        this.database = Objects.requireNonNull(database, "database");
        this.ticketRoot = ticketRoot.toAbsolutePath().normalize();
        this.pendingTicketDelta = Objects.requireNonNull(pendingTicketDelta, "pendingTicketDelta");
        Files.createDirectories(this.ticketRoot);
    }

    public Path ticketRoot() {
        return ticketRoot;
    }

    public synchronized SaveResult savePng(String ticketId, byte[] pngBytes) throws SQLException, IOException {
        validatePng(pngBytes);
        var ticket = loadTicket(ticketId);
        var donorDirectory = ticketRoot.resolve(folderName(ticket.nickname(), ticket.donorId())).normalize();
        if (!donorDirectory.startsWith(ticketRoot)) {
            throw new IOException("ticket directory escaped configured root");
        }
        Files.createDirectories(donorDirectory);

        String fileName = fileName(ticket);
        Path imagePath = donorDirectory.resolve(fileName).normalize();
        writeAtomically(imagePath, pngBytes);

        String relativeImagePath = ticketRoot.relativize(imagePath).toString().replace('\\', '/');
        boolean issuedNow = finalizeTicket(ticket.ticketId(), relativeImagePath);
        if (issuedNow) pendingTicketDelta.accept(-1);

        Path manifestPath = donorDirectory.resolve("issued.json");
        writeManifest(ticket.donorId(), manifestPath);

        return new SaveResult(
            ticket.ticketId(),
            relativeImagePath,
            ticketRoot.relativize(manifestPath).toString().replace('\\', '/'),
            issuedNow,
            "ISSUED"
        );
    }

    private TicketRecord loadTicket(String ticketId) throws SQLException {
        if (ticketId == null || ticketId.isBlank()) throw new IllegalArgumentException("ticketId is required");
        var sql = """
            SELECT ticket_id, donor_id, nickname_at_issue, ticket_sequence, numbers_json,
                   status, image_path, created_at, issued_at
            FROM ticket
            WHERE ticket_id = ?
            """;
        try (var connection = database.open();
             var statement = connection.prepareStatement(sql)) {
            statement.setString(1, ticketId);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) throw new NoSuchElementException("ticket not found: " + ticketId);
                return new TicketRecord(
                    rows.getString("ticket_id"),
                    rows.getString("donor_id"),
                    rows.getString("nickname_at_issue"),
                    rows.getInt("ticket_sequence"),
                    parseNumbers(rows.getString("numbers_json")),
                    rows.getString("status"),
                    rows.getString("image_path"),
                    rows.getString("created_at"),
                    rows.getString("issued_at")
                );
            }
        }
    }

    private boolean finalizeTicket(String ticketId, String imagePath) throws SQLException {
        try (var connection = database.open()) {
            connection.setAutoCommit(false);
            try {
                String donorId;
                String status;
                try (var statement = connection.prepareStatement(
                    "SELECT donor_id, status FROM ticket WHERE ticket_id = ?"
                )) {
                    statement.setString(1, ticketId);
                    try (var rows = statement.executeQuery()) {
                        if (!rows.next()) throw new NoSuchElementException("ticket not found: " + ticketId);
                        donorId = rows.getString("donor_id");
                        status = rows.getString("status");
                    }
                }

                String now = Instant.now().toString();
                if ("ISSUED".equals(status)) {
                    try (var statement = connection.prepareStatement(
                        "UPDATE ticket SET image_path = ?, updated_at = ? WHERE ticket_id = ?"
                    )) {
                        statement.setString(1, imagePath);
                        statement.setString(2, now);
                        statement.setString(3, ticketId);
                        statement.executeUpdate();
                    }
                    connection.commit();
                    return false;
                }

                try (var statement = connection.prepareStatement("""
                    UPDATE ticket
                    SET image_path = ?, status = 'IMAGE_SAVED', updated_at = ?
                    WHERE ticket_id = ?
                    """)) {
                    statement.setString(1, imagePath);
                    statement.setString(2, now);
                    statement.setString(3, ticketId);
                    statement.executeUpdate();
                }

                try (var statement = connection.prepareStatement("""
                    UPDATE ticket
                    SET status = 'ISSUED', issued_at = COALESCE(issued_at, ?), updated_at = ?
                    WHERE ticket_id = ? AND status = 'IMAGE_SAVED'
                    """)) {
                    statement.setString(1, now);
                    statement.setString(2, now);
                    statement.setString(3, ticketId);
                    if (statement.executeUpdate() != 1) {
                        throw new SQLException("failed to finalize ticket: " + ticketId);
                    }
                }

                try (var statement = connection.prepareStatement("""
                    UPDATE donor
                    SET issued_ticket_count = issued_ticket_count + 1, updated_at = ?
                    WHERE donor_id = ?
                    """)) {
                    statement.setString(1, now);
                    statement.setString(2, donorId);
                    if (statement.executeUpdate() != 1) {
                        throw new SQLException("donor not found while finalizing ticket: " + donorId);
                    }
                }

                connection.commit();
                return true;
            } catch (Exception error) {
                connection.rollback();
                if (error instanceof SQLException sqlError) throw sqlError;
                if (error instanceof RuntimeException runtime) throw runtime;
                throw new SQLException("failed to finalize ticket", error);
            } finally {
                connection.setAutoCommit(true);
            }
        }
    }

    private void writeManifest(String donorId, Path manifestPath) throws SQLException, IOException {
        var tickets = new ArrayList<ManifestTicket>();
        String nickname = "";
        long totalBalloons = 0;
        int issuedTicketCount = 0;

        try (var connection = database.open()) {
            try (var donor = connection.prepareStatement("""
                SELECT current_nickname, total_balloons, issued_ticket_count
                FROM donor WHERE donor_id = ?
                """)) {
                donor.setString(1, donorId);
                try (var rows = donor.executeQuery()) {
                    if (rows.next()) {
                        nickname = rows.getString("current_nickname");
                        totalBalloons = rows.getLong("total_balloons");
                        issuedTicketCount = rows.getInt("issued_ticket_count");
                    }
                }
            }

            try (var statement = connection.prepareStatement("""
                SELECT ticket_id, nickname_at_issue, ticket_sequence, numbers_json, image_path, issued_at
                FROM ticket
                WHERE donor_id = ? AND status = 'ISSUED'
                ORDER BY ticket_sequence ASC
                """)) {
                statement.setString(1, donorId);
                try (var rows = statement.executeQuery()) {
                    while (rows.next()) {
                        String image = rows.getString("image_path");
                        String imageFileName = image == null ? null : Path.of(image).getFileName().toString();
                        tickets.add(new ManifestTicket(
                            rows.getInt("ticket_sequence"),
                            rows.getString("ticket_id"),
                            rows.getString("nickname_at_issue"),
                            parseNumbers(rows.getString("numbers_json")),
                            imageFileName,
                            rows.getString("issued_at")
                        ));
                    }
                }
            }
        }

        var manifest = new DonorManifest(
            donorId,
            nickname,
            totalBalloons,
            issuedTicketCount,
            Instant.now().toString(),
            List.copyOf(tickets)
        );
        writeAtomically(manifestPath, GSON.toJson(manifest).getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private static List<Integer> parseNumbers(String json) {
        if (json == null || json.isBlank()) throw new IllegalStateException("ticket numbers are missing");
        Integer[] values = GSON.fromJson(json, Integer[].class);
        if (values == null || values.length == 0) throw new IllegalStateException("ticket numbers are invalid");
        return List.of(values);
    }

    private static String fileName(TicketRecord ticket) {
        String numbers = ticket.numbers().stream()
            .map(number -> String.format("%02d", number))
            .reduce((left, right) -> left + "-" + right)
            .orElse("numbers");
        return String.format(
            "%04d_%s_%s.png",
            ticket.ticketSequence(),
            sanitize(ticket.ticketId(), 80),
            numbers
        );
    }

    private static String folderName(String nickname, String donorId) {
        return sanitize(nickname, 40) + "_" + sanitize(donorId, 32) + "_" + hash8(donorId);
    }

    private static String sanitize(String value, int maxLength) {
        String source = value == null ? "" : value.trim();
        var safe = new StringBuilder(Math.min(source.length(), maxLength));
        for (int index = 0; index < source.length() && safe.length() < maxLength; index++) {
            char ch = source.charAt(index);
            boolean forbidden = ch < 0x20
                || ch == '<' || ch == '>' || ch == ':' || ch == '"'
                || ch == '/' || ch == '\\' || ch == '|' || ch == '?' || ch == '*';
            safe.append(forbidden ? '_' : ch);
        }
        while (!safe.isEmpty() && (safe.charAt(safe.length() - 1) == '.' || safe.charAt(safe.length() - 1) == ' ')) {
            safe.setLength(safe.length() - 1);
        }
        if (safe.isEmpty()) return "unknown";
        return safe.toString();
    }

    private static String hash8(String value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256")
                .digest(String.valueOf(value).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(bytes, 0, 4);
        } catch (Exception error) {
            throw new IllegalStateException("failed to hash donor id", error);
        }
    }

    private static void validatePng(byte[] pngBytes) {
        if (pngBytes == null || pngBytes.length < PNG_SIGNATURE.length) {
            throw new IllegalArgumentException("PNG body is empty or too short");
        }
        for (int i = 0; i < PNG_SIGNATURE.length; i++) {
            if (pngBytes[i] != PNG_SIGNATURE[i]) {
                throw new IllegalArgumentException("request body is not a PNG image");
            }
        }
    }

    private static void writeAtomically(Path target, byte[] bytes) throws IOException {
        Files.createDirectories(target.getParent());
        Path temp = Files.createTempFile(target.getParent(), ".roulette-ticket-", ".tmp");
        try {
            Files.write(temp, bytes);
            try {
                Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException ignored) {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    public record SaveResult(
        String ticketId,
        String imagePath,
        String manifestPath,
        boolean issuedNow,
        String status
    ) {}

    private record TicketRecord(
        String ticketId,
        String donorId,
        String nickname,
        int ticketSequence,
        List<Integer> numbers,
        String status,
        String imagePath,
        String createdAt,
        String issuedAt
    ) {}

    private record ManifestTicket(
        int ticketNumber,
        String ticketId,
        String nickname,
        List<Integer> numbers,
        String image,
        String issuedAt
    ) {}

    private record DonorManifest(
        String donorId,
        String currentNickname,
        long totalBalloons,
        int issuedTicketCount,
        String updatedAt,
        List<ManifestTicket> tickets
    ) {}
}
