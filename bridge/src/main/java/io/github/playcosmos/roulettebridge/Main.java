package io.github.playcosmos.roulettebridge;

import com.google.gson.Gson;
import io.github.playcosmos.roulettebridge.config.ConfigLoader;
import io.github.playcosmos.roulettebridge.db.BridgeDatabase;
import io.github.playcosmos.roulettebridge.issuance.DonationIssuanceEngine;
import io.github.playcosmos.roulettebridge.issuance.PhaseDProbe;
import io.github.playcosmos.roulettebridge.operations.AdminOperationsHandler;
import io.github.playcosmos.roulettebridge.operations.DatabaseBackupService;
import io.github.playcosmos.roulettebridge.operations.EncodingProbe;
import io.github.playcosmos.roulettebridge.operations.FileLog;
import io.github.playcosmos.roulettebridge.operations.ManualAdjustmentService;
import io.github.playcosmos.roulettebridge.operations.WindowsConsoleEncoding;
import io.github.playcosmos.roulettebridge.recovery.PhaseFProbe;
import io.github.playcosmos.roulettebridge.recovery.TicketRecoveryService;
import io.github.playcosmos.roulettebridge.server.BridgeHttpServer;
import io.github.playcosmos.roulettebridge.server.OverlayWebSocketServer;
import io.github.playcosmos.roulettebridge.soop.SoopBridgeAdapter;
import io.github.playcosmos.roulettebridge.soop.SoopProbe;
import io.github.playcosmos.roulettebridge.soop.SoopRuntimeState;
import io.github.playcosmos.roulettebridge.storage.PhaseEProbe;
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
        WindowsConsoleEncoding.configure();

        if (args.length > 0 && "--probe".equals(args[0])) {
            if (args.length < 2 || args[1] == null || args[1].isBlank()) {
                System.err.println("[probe] streamerId argument is required");
                System.exit(2);
                return;
            }
            System.exit(SoopProbe.run(args[1]));
            return;
        }
        if (args.length > 0 && "--phase-d-probe".equals(args[0])) {
            System.exit(PhaseDProbe.run());
            return;
        }
        if (args.length > 0 && "--phase-e-probe".equals(args[0])) {
            System.exit(PhaseEProbe.run());
            return;
        }
        if (args.length > 0 && "--phase-f-probe".equals(args[0])) {
            System.exit(PhaseFProbe.run());
            return;
        }
        if (args.length > 0 && "--encoding-probe".equals(args[0])) {
            System.exit(EncodingProbe.run());
            return;
        }

        Path workingDirectory = AppPaths.applicationRoot();
        Path configPath = args.length > 0
            ? AppPaths.resolveConfig(workingDirectory, args[0])
            : workingDirectory.resolve("config.json");

        System.out.println("[app] root: " + workingDirectory);
        System.out.println("[app] config: " + configPath);

        var config = ConfigLoader.loadOrCreate(configPath);
        var fileLog = FileLog.install(workingDirectory.resolve(config.storage().logDirectory()));
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
        var archive = new TicketArchiveService(
            database,
            workingDirectory.resolve(config.storage().ticketDirectory()),
            pendingTicketCount::addAndGet
        );
        var recovery = new TicketRecoveryService(database);

        websocket.configureRecovery(
            () -> {
                try {
                    return recovery.findPendingIssueEvents().stream()
                        .map(ticket -> new OverlayWebSocketServer.ReplayMessage(ticket.ticketId(), GSON.toJson(ticket)))
                        .toList();
                } catch (Exception error) {
                    throw new IllegalStateException("failed to load pending tickets", error);
                }
            },
            ticketId -> {
                try {
                    recovery.markDispatched(ticketId);
                } catch (Exception error) {
                    throw new IllegalStateException("failed to mark ticket dispatched: " + ticketId, error);
                }
            }
        );
        websocket.start();

        var ticketDispatcher = new java.util.function.Consumer<io.github.playcosmos.roulettebridge.issuance.TicketIssueEvent>() {
            @Override
            public void accept(io.github.playcosmos.roulettebridge.issuance.TicketIssueEvent ticket) {
                websocket.dispatchTicketEvent(ticket.ticketId(), GSON.toJson(ticket));
            }
        };

        var issuance = new DonationIssuanceEngine(
            database,
            config.ticket(),
            ticketDispatcher,
            pendingTicketCount::addAndGet
        );
        var adjustment = new ManualAdjustmentService(
            database,
            config.ticket(),
            ticketDispatcher,
            pendingTicketCount::addAndGet
        );
        var backup = new DatabaseBackupService(
            database,
            workingDirectory.resolve(config.storage().backupDirectory())
        );
        var admin = new AdminOperationsHandler(
            database,
            config.ticket(),
            backup,
            archive,
            adjustment,
            websocket
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
            archive,
            recovery,
            admin
        );
        http.start();
        soop.start();

        String overlayUrl = "http://" + config.server().host() + ":" + config.server().port()
            + "/soop-overlay.html?ws=ws://" + config.server().host() + ":" + config.server().websocketPort();
        System.out.println("[overlay] " + overlayUrl);
        System.out.println("[admin] loopback API: http://127.0.0.1:" + config.server().port() + "/api/admin");

        if (config.server().openBrowserOnStart()) openBrowser(overlayUrl);

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
            System.out.println("[shutdown] complete");
            fileLog.close();
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
