package io.github.playcosmos.roulettebridge;

import com.google.gson.Gson;
import io.github.playcosmos.roulettebridge.config.ConfigLoader;
import io.github.playcosmos.roulettebridge.db.BridgeDatabase;
import io.github.playcosmos.roulettebridge.issuance.DonationIssuanceEngine;
import io.github.playcosmos.roulettebridge.issuance.PhaseDProbe;
import io.github.playcosmos.roulettebridge.server.BridgeHttpServer;
import io.github.playcosmos.roulettebridge.server.OverlayWebSocketServer;
import io.github.playcosmos.roulettebridge.soop.SoopBridgeAdapter;
import io.github.playcosmos.roulettebridge.soop.SoopProbe;
import io.github.playcosmos.roulettebridge.soop.SoopRuntimeState;
import io.github.playcosmos.roulettebridge.storage.TicketArchiveService;
import java.awt.Desktop;
import java.net.URI;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

public final class Main {
    private static final Gson GSON = new Gson();

    private Main() {}

    public static void main(String[] args) throws Exception {
        if (args.length > 0 && "--probe".equals(args[0])) {
            String streamerId = args.length > 1 ? args[1] : "20221010";
            System.exit(SoopProbe.run(streamerId));
            return;
        }

        if (args.length > 0 && "--phase-d-probe".equals(args[0])) {
            System.exit(PhaseDProbe.run());
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
            "[recovery] " + ticket.ticketId()
                + " / #" + (ticket.ticketSequence() == null ? "?" : ticket.ticketSequence())
                + " / " + ticket.nickname()
                + " / " + ticket.status()
        ));

        var websocket = new OverlayWebSocketServer(config.server().host(), config.server().websocketPort());
        websocket.start();

        var archive = new TicketArchiveService(
            database,
            workingDirectory.resolve(config.storage().ticketDirectory()),
            pendingTicketCount::addAndGet
        );

        var issuance = new DonationIssuanceEngine(
            database,
            config.ticket(),
            ticket -> websocket.broadcastTicketEvent(GSON.toJson(ticket)),
            pendingTicketCount::addAndGet
        );

        var soopState = new SoopRuntimeState(config.streamerId());
        var soop = new SoopBridgeAdapter(config, soopState, donation -> {
            try {
                var result = issuance.process(donation);
                if (result.duplicate()) {
                    System.out.println("[issuance] duplicate donation ignored: " + result.eventId());
                    return;
                }
                System.out.println(
                    "[issuance] " + donation.nickname()
                        + " total=" + result.totalBalloons()
                        + " tickets=" + result.allocatedTicketCount()
                        + " new=" + result.newTicketCount()
                        + " remainder=" + result.remainderBalloons()
                );
            } catch (Exception error) {
                System.err.println("[issuance] donation processing failed: " + error.getMessage());
                error.printStackTrace(System.err);
            }
        });

        var http = new BridgeHttpServer(
            config,
            workingDirectory,
            database.path(),
            pendingTicketCount::get,
            websocket::connectedClients,
            soopState::snapshot,
            archive
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
