package io.github.playcosmos.roulettebridge.boardserver;

public record BoardServerConfig(
    String streamerId,
    Server server,
    Storage storage,
    Soop soop
) {
    public static BoardServerConfig defaults() {
        return new BoardServerConfig(
            "",
            new Server("127.0.0.1", 17830, 17831, true),
            new Storage("./data/board-game.db", "./web", "./logs"),
            new Soop(true, 30)
        );
    }

    public BoardServerConfig normalized() {
        var d = defaults();
        String id = streamerId == null ? "" : streamerId.trim();
        if ("STREAMER_ID".equals(id)) id = "";
        return new BoardServerConfig(
            id,
            server == null ? d.server : server.normalized(),
            storage == null ? d.storage : storage.normalized(),
            soop == null ? d.soop : soop.normalized()
        );
    }

    public record Server(String host, int port, int websocketPort, boolean openBrowserOnStart) {
        Server normalized() {
            String h = host == null || host.isBlank() ? "127.0.0.1" : host.trim();
            int p = port > 0 && port <= 65535 ? port : 17830;
            int ws = websocketPort > 0 && websocketPort <= 65535 ? websocketPort : p + 1;
            return new Server(h, p, ws, openBrowserOnStart);
        }
    }

    public record Storage(String databasePath, String webRoot, String logDirectory) {
        Storage normalized() {
            return new Storage(
                valueOrDefault(databasePath, "./data/board-game.db"),
                valueOrDefault(webRoot, "./web"),
                valueOrDefault(logDirectory, "./logs")
            );
        }

        private static String valueOrDefault(String value, String fallback) {
            return value == null || value.isBlank() ? fallback : value.trim();
        }
    }

    public record Soop(boolean enabled, int offlinePollSeconds) {
        Soop normalized() {
            return new Soop(enabled, offlinePollSeconds >= 5 ? offlinePollSeconds : 30);
        }
    }
}
