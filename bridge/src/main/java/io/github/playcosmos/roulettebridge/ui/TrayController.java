package io.github.playcosmos.roulettebridge.ui;

import java.awt.AWTException;
import java.awt.Color;
import java.awt.Desktop;
import java.awt.EventQueue;
import java.awt.Graphics2D;
import java.awt.Image;
import java.awt.MenuItem;
import java.awt.PopupMenu;
import java.awt.RenderingHints;
import java.awt.SystemTray;
import java.awt.TrayIcon;
import java.awt.image.BufferedImage;
import java.net.URI;
import java.util.Objects;
import java.util.Timer;
import java.util.TimerTask;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;

public final class TrayController implements AutoCloseable {
    private final String adminUrl;
    private final String overlayUrl;
    private final Supplier<String> statusSupplier;
    private final Runnable reconnectAction;
    private final Runnable exitAction;
    private final AtomicBoolean exitRequested = new AtomicBoolean(false);
    private final Timer refreshTimer = new Timer("tray-status", true);
    private final TrayIcon trayIcon;
    private final MenuItem statusItem;
    private final MenuItem reconnectItem;
    private final MenuItem exitItem;

    private TrayController(
        String adminUrl,
        String overlayUrl,
        Supplier<String> statusSupplier,
        Runnable reconnectAction,
        Runnable exitAction
    ) throws AWTException {
        this.adminUrl = Objects.requireNonNull(adminUrl, "adminUrl");
        this.overlayUrl = Objects.requireNonNull(overlayUrl, "overlayUrl");
        this.statusSupplier = Objects.requireNonNull(statusSupplier, "statusSupplier");
        this.reconnectAction = Objects.requireNonNull(reconnectAction, "reconnectAction");
        this.exitAction = Objects.requireNonNull(exitAction, "exitAction");

        var popup = new PopupMenu();
        statusItem = new MenuItem("상태: 확인 중");
        statusItem.setEnabled(false);
        popup.add(statusItem);
        popup.addSeparator();

        var openAdmin = new MenuItem("관리자 페이지 열기");
        openAdmin.addActionListener(event -> open(adminUrl));
        popup.add(openAdmin);

        var openOverlay = new MenuItem("OBS 오버레이 열기");
        openOverlay.addActionListener(event -> open(overlayUrl));
        popup.add(openOverlay);

        reconnectItem = new MenuItem("SOOP 재연결");
        reconnectItem.addActionListener(event -> {
            if (!exitRequested.get()) reconnectAction.run();
        });
        popup.add(reconnectItem);

        popup.addSeparator();
        exitItem = new MenuItem("종료");
        exitItem.addActionListener(event -> requestExit());
        popup.add(exitItem);

        trayIcon = new TrayIcon(createIcon(), "RamyaniGameServer", popup);
        trayIcon.setImageAutoSize(true);
        trayIcon.addActionListener(event -> {
            if (!exitRequested.get()) open(adminUrl);
        });
        SystemTray.getSystemTray().add(trayIcon);

        refreshTimer.scheduleAtFixedRate(new TimerTask() {
            @Override
            public void run() {
                if (exitRequested.get()) return;
                String status = statusSupplier.get();
                EventQueue.invokeLater(() -> updateStatus(status));
            }
        }, 0L, 2000L);
    }

    public static TrayController install(
        String adminUrl,
        String overlayUrl,
        Supplier<String> statusSupplier,
        Runnable reconnectAction,
        Runnable exitAction
    ) {
        if (!SystemTray.isSupported()) {
            System.err.println("[tray] system tray is not supported");
            return null;
        }
        try {
            var controller = new TrayController(
                adminUrl,
                overlayUrl,
                statusSupplier,
                reconnectAction,
                exitAction
            );
            System.out.println("[tray] installed");
            return controller;
        } catch (Exception error) {
            System.err.println("[tray] failed to install: " + error.getMessage());
            return null;
        }
    }

    private void requestExit() {
        if (!exitRequested.compareAndSet(false, true)) return;
        statusItem.setLabel("상태: 종료 중");
        trayIcon.setToolTip("RamyaniGameServer · 종료 중");
        reconnectItem.setEnabled(false);
        exitItem.setEnabled(false);

        // Never call System.exit() on the AWT tray event thread. Delegate the request and
        // return immediately so the shutdown coordinator can remove AWT resources safely.
        Thread.ofPlatform().name("ramyani-game-server-tray-exit-request").start(exitAction);
    }

    private void updateStatus(String status) {
        if (exitRequested.get()) return;
        String label = switch (status == null ? "" : status) {
            case "CONNECTED" -> "연결됨";
            case "PROBING" -> "방송 확인 중";
            case "CONNECTING" -> "채팅 연결 중";
            case "RECONNECTING" -> "재연결 중";
            case "WAITING_FOR_STREAMER_ID" -> "설정 필요";
            case "OFFLINE_OR_UNAVAILABLE" -> "방송 대기";
            case "CONNECTION_FAILED" -> "연결 실패";
            case "DISCONNECTED_ERROR" -> "연결 오류";
            case "DISCONNECTED" -> "연결 끊김";
            case "DISABLED" -> "비활성";
            case "STOPPED" -> "중지됨";
            default -> "대기 중";
        };
        statusItem.setLabel("상태: " + label);
        trayIcon.setToolTip("RamyaniGameServer · " + label);
    }

    private static Image createIcon() {
        int size = 32;
        var image = new BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = image.createGraphics();
        try {
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g.setColor(new Color(25, 25, 30));
            g.fillRoundRect(1, 1, size - 2, size - 2, 9, 9);
            g.setColor(Color.WHITE);
            g.drawOval(7, 7, 18, 18);
            g.drawLine(16, 8, 16, 24);
            g.drawLine(8, 16, 24, 16);
        } finally {
            g.dispose();
        }
        return image;
    }

    private static void open(String url) {
        try {
            if (!Desktop.isDesktopSupported() || !Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
                return;
            }
            Desktop.getDesktop().browse(URI.create(url));
        } catch (Exception error) {
            System.err.println("[tray] browser open failed: " + error.getMessage());
        }
    }

    @Override
    public void close() {
        exitRequested.set(true);
        refreshTimer.cancel();
        try {
            SystemTray.getSystemTray().remove(trayIcon);
        } catch (Exception ignored) {
            // best effort during shutdown
        }
    }
}
