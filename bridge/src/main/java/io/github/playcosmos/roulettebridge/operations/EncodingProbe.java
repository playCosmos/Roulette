package io.github.playcosmos.roulettebridge.operations;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.logging.Logger;

public final class EncodingProbe {
    private static final String SAMPLE = "한글인코딩검증-복구테스트-라먀니";
    private static final Logger JUL = Logger.getLogger("roulette.encoding.probe");

    private EncodingProbe() {}

    public static int run() {
        Path root = null;
        try {
            root = Files.createTempDirectory("roulette-encoding-");
            Path logPath;
            try (var log = FileLog.install(root.resolve("logs"))) {
                logPath = log.path();
                System.out.println("[encoding-probe] " + SAMPLE);
                System.err.println("[encoding-probe-err] " + SAMPLE);
                JUL.info("JUL-한글메시지-정보레벨검증");
            }

            String text = Files.readString(logPath, StandardCharsets.UTF_8);
            require(text.contains("[encoding-probe] " + SAMPLE), "stdout Korean text missing from UTF-8 log");
            require(text.contains("[encoding-probe-err] " + SAMPLE), "stderr Korean text missing from UTF-8 log");
            require(text.contains("INFO"), "JUL level name INFO missing from log");
            require(text.contains("JUL-한글메시지-정보레벨검증"), "JUL Korean message missing from UTF-8 log");
            require(!text.contains("????"), "replacement question marks detected in UTF-8 log");
            require(!text.contains("정보 roulette.encoding.probe"), "localized JUL level name leaked into log");

            System.out.println("[encoding-probe] PASS");
            return 0;
        } catch (Exception error) {
            System.err.println("[encoding-probe] FAIL: " + error.getMessage());
            error.printStackTrace(System.err);
            return 1;
        } finally {
            if (root != null) deleteRecursively(root);
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }

    private static void deleteRecursively(Path root) {
        try (var paths = Files.walk(root)) {
            paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                try { Files.deleteIfExists(path); } catch (Exception ignored) {}
            });
        } catch (Exception ignored) {}
    }
}
