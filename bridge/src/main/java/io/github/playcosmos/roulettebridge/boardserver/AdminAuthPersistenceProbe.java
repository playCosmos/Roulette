package io.github.playcosmos.roulettebridge.boardserver;

import java.nio.file.Files;
import java.time.Instant;

public final class AdminAuthPersistenceProbe {
    private AdminAuthPersistenceProbe() {}

    public static void main(String[] args) {
        System.exit(run());
    }

    public static int run() {
        try {
            var root = Files.createTempDirectory(
                "ramyani-admin-auth-probe-"
            );
            var database = new BoardGameDatabase(
                root.resolve("data/board-game.db")
            );
            database.initialize();

            var firstStore = new AdminAuthStore(database);
            String initialToken = firstStore.bootstrapTokenOrCreate(
                () -> "initial-token"
            );
            require(
                "initial-token".equals(initialToken),
                "initial token must be created"
            );

            Instant initialExpiry = Instant.now().plusSeconds(3600);
            firstStore.createSession("probe-session", initialExpiry);

            var reopenedStore = new AdminAuthStore(database);
            require(
                initialToken.equals(
                    reopenedStore.bootstrapTokenOrCreate(
                        () -> "replacement-token"
                    )
                ),
                "bootstrap token must survive store recreation"
            );
            require(
                initialExpiry.equals(
                    reopenedStore.sessionExpiresAt("probe-session")
                ),
                "admin session must survive store recreation"
            );

            Instant refreshedExpiry = Instant.now().plusSeconds(7200);
            reopenedStore.refreshSession(
                "probe-session",
                refreshedExpiry
            );
            var reopenedAgain = new AdminAuthStore(database);
            require(
                refreshedExpiry.equals(
                    reopenedAgain.sessionExpiresAt("probe-session")
                ),
                "refreshed expiry must persist"
            );

            reopenedAgain.rotateBootstrapToken("rotated-token");
            require(
                "rotated-token".equals(
                    reopenedAgain.bootstrapTokenOrCreate(
                        () -> "unused-token"
                    )
                ),
                "rotated token must persist"
            );
            require(
                reopenedAgain.sessionExpiresAt("probe-session") == null,
                "token rotation must revoke existing sessions"
            );

            System.out.println(
                "Admin auth persistence probe passed."
            );
            return 0;
        } catch (Exception error) {
            error.printStackTrace();
            return 1;
        }
    }

    private static void require(
        boolean condition,
        String message
    ) {
        if (!condition) {
            throw new IllegalStateException(message);
        }
    }
}
