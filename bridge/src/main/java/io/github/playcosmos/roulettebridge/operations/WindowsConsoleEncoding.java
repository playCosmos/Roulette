package io.github.playcosmos.roulettebridge.operations;

import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * Makes an attached Windows console use UTF-8 and aligns Java stdout/stderr
 * with that code page. Tray/GUI packaging has no console, so this is skipped
 * there to avoid spawning a transient command window.
 */
public final class WindowsConsoleEncoding {
    private WindowsConsoleEncoding() {}

    public static void configure() {
        if (!System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win")) return;
        if (System.console() == null) return;

        try {
            var process = new ProcessBuilder("cmd.exe", "/d", "/c", "chcp 65001 > nul")
                .inheritIO()
                .start();
            process.waitFor();
        } catch (Exception ignored) {
            // Continue: modern terminals may already be UTF-8 capable.
        }

        try {
            System.setOut(new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8));
            System.setErr(new PrintStream(new FileOutputStream(FileDescriptor.err), true, StandardCharsets.UTF_8));
        } catch (Exception ignored) {
            // Fall back to the streams created by the launcher.
        }
    }
}
