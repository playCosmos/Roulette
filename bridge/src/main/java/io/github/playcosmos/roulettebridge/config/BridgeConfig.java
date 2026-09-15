package io.github.playcosmos.roulettebridge.config;

import java.util.Locale;

public record BridgeConfig(
    String streamerId,
    Ticket ticket,
    Server server,
    Storage storage,
    Soop soop
) {
    public static BridgeConfig defaults() {
        return new BridgeConfig(
            "",
            new Ticket(50, 28, 7, Ticket.MODE_SINGLE_DONATION),
            new Server("127.0.0.1", 17820, 17821, false),
            new Storage("./data/roulette.db", "./tickets", "./web", "./backups", "./logs"),
            new Soop(true, 30)
        );
    }

    public BridgeConfig normalized() {
        var d = defaults();
        var normalizedTicket = ticket == null ? d.ticket : ticket.normalized();
        var normalizedServer = server == null ? d.server : server.normalized();
        var normalizedStorage = storage == null ? d.storage : storage.normalized();
        var normalizedSoop = soop == null ? d.soop : soop.normalized();
        var normalizedStreamerId = streamerId == null ? "" : streamerId.trim();
        if ("STREAMER_ID".equals(normalizedStreamerId)) normalizedStreamerId = "";
        return new BridgeConfig(normalizedStreamerId, normalizedTicket, normalizedServer, normalizedStorage, normalizedSoop);
    }

    public record Ticket(int balloonsPerTicket, int numberMax, int numberCount, String issuanceMode) {
        public static final String MODE_SINGLE_DONATION = "single_donation";
        public static final String MODE_CUMULATIVE = "cumulative";

        public Ticket(int balloonsPerTicket, int numberMax, int numberCount) {
            this(balloonsPerTicket, numberMax, numberCount, MODE_SINGLE_DONATION);
        }

        Ticket normalized() {
            int threshold = balloonsPerTicket > 0 ? balloonsPerTicket : 50;
            int max = numberMax > 0 ? numberMax : 28;
            int count = numberCount > 0 && numberCount <= max ? numberCount : 7;
            String mode = normalizedIssuanceMode(issuanceMode);
            return new Ticket(threshold, max, count, mode);
        }

        public boolean singleDonationMode() {
            return MODE_SINGLE_DONATION.equals(normalizedIssuanceMode(issuanceMode));
        }

        public boolean cumulativeMode() {
            return MODE_CUMULATIVE.equals(normalizedIssuanceMode(issuanceMode));
        }

        private static String normalizedIssuanceMode(String value) {
            if (value == null || value.isBlank()) return MODE_SINGLE_DONATION;
            return switch (value.trim().toLowerCase(Locale.ROOT)) {
                case "cumulative", "accumulate", "accumulated" -> MODE_CUMULATIVE;
                case "single", "single_donation", "single-donation", "per_donation", "per-donation" -> MODE_SINGLE_DONATION;
                default -> MODE_SINGLE_DONATION;
            };
        }
    }

    public record Server(String host, int port, int websocketPort, boolean openBrowserOnStart) {
        Server normalized() {
            String normalizedHost = host == null || host.isBlank() ? "127.0.0.1" : host.trim();
            int normalizedPort = port > 0 && port <= 65535 ? port : 17820;
            int normalizedWsPort = websocketPort > 0 && websocketPort <= 65535
                ? websocketPort
                : normalizedPort + 1;
            return new Server(normalizedHost, normalizedPort, normalizedWsPort, openBrowserOnStart);
        }
    }

    public record Storage(
        String databasePath,
        String ticketDirectory,
        String webRoot,
        String backupDirectory,
        String logDirectory
    ) {
        Storage normalized() {
            return new Storage(
                valueOrDefault(databasePath, "./data/roulette.db"),
                valueOrDefault(ticketDirectory, "./tickets"),
                valueOrDefault(webRoot, "./web"),
                valueOrDefault(backupDirectory, "./backups"),
                valueOrDefault(logDirectory, "./logs")
            );
        }

        private static String valueOrDefault(String value, String fallback) {
            return value == null || value.isBlank() ? fallback : value.trim();
        }
    }

    public record Soop(boolean enabled, int offlinePollSeconds) {
        Soop normalized() {
            int poll = offlinePollSeconds >= 5 ? offlinePollSeconds : 30;
            return new Soop(enabled, poll);
        }
    }
}
