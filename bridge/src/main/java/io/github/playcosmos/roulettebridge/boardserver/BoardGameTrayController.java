package io.github.playcosmos.roulettebridge.boardserver;

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
import java.util.Timer;
import java.util.TimerTask;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;

public final class BoardGameTrayController implements AutoCloseable {
    private final String adminUrl;
    private final Supplier<String> statusSupplier;
    private final Runnable reconnectAction;
    private final Runnable exitAction;
    private final AtomicBoolean exitRequested = new AtomicBoolean(false);
    private final Timer refreshTimer = new Timer("board-tray-status", true);
    private final TrayIcon trayIcon;
    private final MenuItem statusItem;

    private BoardGameTrayController(
        String adminUrl,
        Supplier<String> statusSupplier,
        Runnable reconnectAction,
        Runnable exitAction
    ) throws AWTException {
        this.adminUrl = adminUrl;
        this.statusSupplier = statusSupplier;
        this.reconnectAction = reconnectAction;
        this.exitAction = exitAction;

        var popup = new PopupMenu();
        statusItem = new MenuItem("상태: 확인 중");
        statusItem.setEnabled(false);
        popup.add(statusItem);
        popup.addSeparator();

        var openAdmin = new MenuItem("보드게임 관리 페이지 열기");
        openAdmin.addActionListener(event -> open(adminUrl));
        popup.add(openAdmin);

        var reconnect = new MenuItem("SOOP 재연결");
        reconnect.addActionListener(event -> {
            if (!exitRequested.get()) reconnectAction.run();
        });
        popup.add(reconnect);

        popup.addSeparator();
        var exit = new MenuItem("종료");
        exit.addActionListener(event -> requestExit());
        popup.add(exit);

        trayIcon = new TrayIcon(createIcon(), "RamyaniBoardGameServer", popup);
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

    public static BoardGameTrayController install(
        String adminUrl,
        Supplier<String> statusSupplier,
        Runnable reconnectAction,
        Runnable exitAction
    ) {
        if (!SystemTray.isSupported()) return null;
        try {
            return new BoardGameTrayController(adminUrl, statusSupplier, reconnectAction, exitAction);
        } catch (Exception error) {
            System.err.println("[board-tray] " + error.getMessage());
            return null;
        }
    }

    private void requestExit() {
        if (!exitRequested.compareAndSet(false, true)) return;
        statusItem.setLabel("상태: 종료 중");
        Thread.ofPlatform().name("board-server-tray-exit").start(exitAction);
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
            case "DISABLED" -> "비활성";
            case "STOPPED" -> "중지됨";
            default -> "대기 중";
        };
        statusItem.setLabel("상태: " + label);
        trayIcon.setToolTip("RamyaniBoardGameServer · " + label);
    }

    private static Image createIcon() {
        int size = 32;
        var image = new BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = image.createGraphics();
        try {
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g.setColor(new Color(25, 25, 30));
            g.fillRoundRect(1, 1, size - 2, size - 2, 8, 8);
            g.setColor(Color.WHITE);
            g.drawRoundRect(6, 6, 20, 20, 5, 5);
            g.drawLine(16, 6, 16, 26);
            g.drawLine(6, 16, 26, 16);
        } finally {
            g.dispose();
        }
        return image;
    }

    private static void open(String url) {
        try {
            if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
                Desktop.getDesktop().browse(URI.create(url));
            }
        } catch (Exception error) {
            System.err.println("[board-tray] browser open failed: " + error.getMessage());
        }
    }

    @Override
    public void close() {
        exitRequested.set(true);
        refreshTimer.cancel();
        try {
            SystemTray.getSystemTray().remove(trayIcon);
        } catch (Exception ignored) {
        }
    }
}
