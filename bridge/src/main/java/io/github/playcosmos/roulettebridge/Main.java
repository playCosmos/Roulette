package io.github.playcosmos.roulettebridge;

import io.github.playcosmos.roulettebridge.config.ConfigLoader;
import io.github.playcosmos.roulettebridge.db.BridgeDatabase;
import io.github.playcosmos.roulettebridge.server.BridgeHttpServer;
import io.github.playcosmos.roulettebridge.server.OverlayWebSocketServer;
import io.github.playcosmos.roulettebridge.soop.SoopBridgeAdapter;
import io.github.playcosmos.roulettebridge.soop.SoopProbe;
import io.github.playcosmos.roulettebridge.soop.SoopRuntimeState;
import java.awt.Desktop;
import java.net.URI;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

public final class Main {
    private Main() {}

    public static void main(String[] args) throws Exception {
        if (args.length > 0 && "--probe".equals(args[0])) {
            String streamerId = args.length > 1 ? args[1] : "20221010";
            System.exit(SoopProbe.run(streamerId));
            return;
        }

        Path workingDirectory = Path.of("").toAbsolutePath().normalize();
        Path configPath = args.length > 0
            ? workingDirectory.resolve(args[0]).normalize()
            : workingDirectory.resolve("config.json");

        var config = ConfigLoader.loadOrCreate(configPath);
        var database = new BridgeDatabase(workingDirectory.resolve(config.storage().databasePath()));
        database.initialize();

        var recoverable = database.findRecoverableTickets();
        var pendingTicketCount = new AtomicInteger(recoverable.size());
        System.out.println("[recovery] recoverable tickets: " + recoverable.size());
        recoverable.forEach(ticket -> System.out.println(
            "[recovery] " + ticket.ticketId() + " / " + ticket.nickname() + " / " + ticket.status()
        ));

        var websocket = new OverlayWebSocketServer(config.server().host(), config.server().websocketPort());
        websocket.start();

        var soopState = new SoopRuntimeState(config.streamerId());
        var soop = new SoopBridgeAdapter(config, soopState, donation -> {
            // Phase D에서 이 지점에 후원 누적/티켓 발급 엔진을 연결한다.
        });

        var http = new BridgeHttpServer(
            config,
            workingDirectory,
            database.path(),
            pendingTicketCount::get,
            websocket::connectedClients,
            soopState::snapshot
        );
        http.start();
        soop.start();

        String overlayUrl = "http://" + config.server().host() + ":" + config.server().port()
            + "/soop-overlay.html?ws=ws://" + config.server().host() + ":" + config.server().websocketPort();
        System.out.println("[overlay] " + overlayUrl);

        if (config.server().openBrowserOnStart()) {
            openBrowser(overlayUrl);
        }

        var shutdown = new CountDownLatch(1);
        Runtime.getRuntime().addShutdownHook(Thread.ofPlatform().name("roulette-bridge-shutdown").unstarted(() -> {
            System.out.println("[shutdown] stopping services");
            soop.close();
            http.close();
            try {
                websocket.stop(2000);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            shutdown.countDown();
        }));

        shutdown.await();
    }

    private static void openBrowser(String url) {
        try {
            if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
                Desktop.getDesktop().browse(URI.create(url));
            }
        } catch (Exception error) {
            System.err.println("[browser] " + error.getMessage());
        }
    }
}
