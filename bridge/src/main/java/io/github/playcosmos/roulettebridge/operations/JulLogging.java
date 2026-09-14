package io.github.playcosmos.roulettebridge.operations;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogManager;
import java.util.logging.LogRecord;
import java.util.logging.Logger;

/**
 * Routes java.util.logging through the application's current System.err.
 *
 * <p>The JDK ConsoleHandler has its own encoding/localization path. On Korean
 * Windows this can localize INFO as "정보" and then encode it differently from
 * the console. Routing records through System.err keeps the same character
 * path used by FileLog, while level names remain stable ASCII tokens such as
 * INFO/WARNING/SEVERE.</p>
 */
public final class JulLogging {
    private static final DateTimeFormatter TIME = DateTimeFormatter
        .ofPattern("yyyy-MM-dd HH:mm:ss")
        .withZone(ZoneId.systemDefault());

    private JulLogging() {}

    public static synchronized void install() {
        Logger root = LogManager.getLogManager().getLogger("");
        if (root == null) return;

        for (Handler handler : root.getHandlers()) {
            root.removeHandler(handler);
            try {
                handler.close();
            } catch (Exception ignored) {
                // Nothing useful to do here.
            }
        }

        var handler = new SystemErrHandler();
        handler.setLevel(Level.ALL);
        root.addHandler(handler);
    }

    private static final class SystemErrHandler extends Handler {
        @Override
        public synchronized void publish(LogRecord record) {
            if (record == null || !isLoggable(record)) return;

            String logger = record.getSourceClassName();
            if (logger == null || logger.isBlank()) logger = record.getLoggerName();
            if (logger == null || logger.isBlank()) logger = "jul";

            String message;
            try {
                message = getFormatter() == null ? record.getMessage() : getFormatter().formatMessage(record);
            } catch (Exception ignored) {
                message = record.getMessage();
            }
            if (message == null) message = "";

            var line = new StringBuilder(160)
                .append(TIME.format(Instant.ofEpochMilli(record.getMillis())))
                .append(' ')
                .append(record.getLevel().getName())
                .append(' ')
                .append(logger)
                .append(" - ")
                .append(message)
                .append(System.lineSeparator());

            if (record.getThrown() != null) {
                var stack = new StringWriter();
                record.getThrown().printStackTrace(new PrintWriter(stack));
                line.append(stack);
            }

            System.err.print(line);
        }

        @Override
        public void flush() {
            System.err.flush();
        }

        @Override
        public void close() {
            flush();
        }
    }
}
