package io.github.playcosmos.roulettebridge.boardserver;

import com.google.gson.Gson;
import io.github.playcosmos.roulettebridge.config.BridgeConfig;
import io.github.playcosmos.roulettebridge.operations.FileLog;
import io.github.playcosmos.roulettebridge.operations.WindowsConsoleEncoding;
import io.github.playcosmos.roulettebridge.room.BoardGameRuntimeEngine;
import io.github.playcosmos.roulettebridge.room.RoomHttpHandler;
import io.github.playcosmos.roulettebridge.room.RoomService;
import io.github.playcosmos.roulettebridge.soop.SoopBridgeAdapter;
import io.github.playcosmos.roulettebridge.soop.SoopRuntimeState;
import java.awt.Desktop;
import java.net.URI;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

public final class BoardGameServerMain {
    private static final Gson GSON = new Gson();
    private static final long EXIT_WATCHDOG_MILLIS = 10_000L;

    private BoardGameServerMain() {}

    public static void main(String[] args) throws Exception {
        WindowsConsoleEncoding.configure();

        if (args.length > 0 && "--board-server-probe".equals(args[0])) {
            System.exit(BoardServerProbe.run());
            return;
        }

        Path root = applicationRoot();
        Path configPath = args.length > 0
            ? resolve(root, args[0])
            : root.resolve("config.json");

        var config = BoardServerConfigLoader.loadOrCreate(configPath);
        var fileLog = FileLog.install(root.resolve(config.storage().logDirectory()));
        var database = new BoardGameDatabase(root.resolve(config.storage().databasePath()));
        database.initialize();

        System.out.println("[board-server] root=" + root);
        System.out.println("[board-server] config=" + configPath);
        System.out.println("[board-server] database=" + database.path());

        var websocket = new BoardGameWebSocketServer(
            config.server().host(),
            config.server().websocketPort()
        );
        websocket.start();

        var runtime = new BoardGameRuntimeEngine(
            database,
            event -> websocket.broadcastEvent(GSON.toJson(event))
        );
        int recovered = runtime.recoverQueuedDonations();
        if (recovered > 0) {
            System.out.println("[board-server] recovered queued donations=" + recovered);
        }

        var roomService = new RoomService(database);
        roomService.terminateExpiredRooms();

        var lifecycleExecutor = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "board-room-lifecycle");
            thread.setDaemon(true);
            return thread;
        });
        lifecycleExecutor.scheduleAtFixedRate(() -> {
            try {
                int terminated = roomService.terminateExpiredRooms();
                if (terminated > 0) {
                    System.out.println("[board-room] auto-terminated=" + terminated);
                }
            } catch (Exception error) {
                System.err.println("[board-room] expiry scan failed: " + error.getMessage());
            }
        }, 1, 1, TimeUnit.MINUTES);

        var roomHttp = new RoomHttpHandler(roomService, runtime);
        var soopState = new SoopRuntimeState(config.streamerId());

        var bridgeConfig = new BridgeConfig(
            config.streamerId(),
            BridgeConfig.defaults().ticket(),
            new BridgeConfig.Server(
                config.server().host(),
                config.server().port(),
                config.server().websocketPort(),
                config.server().openBrowserOnStart()
            ),
            new BridgeConfig.Storage(
                config.storage().databasePath(),
                "./unused-tickets",
                config.storage().webRoot(),
                "./unused-backups",
                config.storage().logDirectory()
            ),
            new BridgeConfig.Soop(
                config.soop().enabled(),
                config.soop().offlinePollSeconds()
            )
        ).normalized();

        var soop = new SoopBridgeAdapter(
            bridgeConfig,
            soopState,
            donation -> {
                try {
                    var result = runtime.process(donation);
                    if (
                        result.processedRooms() > 0 ||
                        result.duplicateRooms() > 0 ||
                        result.queuedRooms() > 0 ||
                        result.ignoredRooms() > 0
                    ) {
                        System.out.println(
                            "[board-game] donor=" + donation.donorId()
                                + " balloons=" + donation.balloonCount()
                                + " matched=" + result.matchedRooms()
                                + " processed=" + result.processedRooms()
                                + " queued=" + result.queuedRooms()
                                + " ignored=" + result.ignoredRooms()
                                + " duplicates=" + result.duplicateRooms()
                        );
                    }
                } catch (Exception error) {
                    System.err.println("[board-game] donation processing failed: " + error.getMessage());
                    error.printStackTrace(System.err);
                }
            },
            (bid, event) -> {}
        );

        var http = new BoardGameHttpServer(
            config,
            root,
            database.path(),
            websocket::connectedClients,
            soopState::snapshot,
            roomHttp
        );
        http.start();
        soop.start();

        String adminUrl = "http://127.0.0.1:" + config.server().port() + "/board-admin.html";
        System.out.println("[board-admin] " + adminUrl);

        var shutdown = new CountDownLatch(1);
        var shutdownStarted = new AtomicBoolean(false);
        var trayRef = new AtomicReference<BoardGameTrayController>();

        Runnable stop = () -> {
            if (!shutdownStarted.compareAndSet(false, true)) return;
            var tray = trayRef.getAndSet(null);
            if (tray != null) {
                try { tray.close(); } catch (Exception ignored) {}
            }
            lifecycleExecutor.shutdownNow();
            try { http.close(); } catch (Exception ignored) {}
            try { websocket.stop(2000); }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            catch (Exception ignored) {}
            try { soop.close(); } catch (Exception ignored) {}
            try { fileLog.close(); } catch (Exception ignored) {}
            shutdown.countDown();
        };

        Runnable explicitExit = () -> {
            Thread.ofPlatform().daemon(true).name("board-server-exit-watchdog").start(() -> {
                try {
                    Thread.sleep(EXIT_WATCHDOG_MILLIS);
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                    return;
                }
                if (shutdown.getCount() > 0) Runtime.getRuntime().halt(0);
            });
            stop.run();
            System.exit(0);
        };

        Runtime.getRuntime().addShutdownHook(
            Thread.ofPlatform().name("board-server-shutdown").unstarted(stop)
        );

        var tray = BoardGameTrayController.install(
            adminUrl,
            soopState::status,
            soop::reconnectNow,
            explicitExit
        );
        trayRef.set(tray);

        if (
            config.streamerId() == null ||
            config.streamerId().isBlank() ||
            tray == null ||
            config.server().openBrowserOnStart()
        ) {
            openBrowser(adminUrl);
        }

        shutdown.await();
    }

    private static Path applicationRoot() {
        String override = System.getenv("RAMYANI_BOARD_GAME_SERVER_HOME");
        if (override != null && !override.isBlank()) {
            return Path.of(override).toAbsolutePath().normalize();
        }
        String launcher = System.getProperty("jpackage.app-path");
        if (launcher != null && !launcher.isBlank()) {
            Path parent = Path.of(launcher).toAbsolutePath().normalize().getParent();
            if (parent != null) return parent;
        }
        return Path.of("").toAbsolutePath().normalize();
    }

    private static Path resolve(Path root, String configured) {
        Path path = Path.of(configured);
        return path.isAbsolute() ? path.normalize() : root.resolve(path).normalize();
    }

    private static void openBrowser(String url) {
        try {
            if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
                Desktop.getDesktop().browse(URI.create(url));
            }
        } catch (Exception error) {
            System.err.println("[board-server] browser open failed: " + error.getMessage());
        }
    }
}
