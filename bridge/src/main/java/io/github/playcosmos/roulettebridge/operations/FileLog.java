package io.github.playcosmos.roulettebridge.operations;

import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

public final class FileLog implements AutoCloseable {
    private static final DateTimeFormatter FILE_TIME = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss");

    private final PrintStream originalOut;
    private final PrintStream originalErr;
    private final PrintStream file;
    private final PrintStream teeOut;
    private final PrintStream teeErr;
    private final Path path;

    private FileLog(PrintStream originalOut, PrintStream originalErr, PrintStream file, Path path) {
        this.originalOut = originalOut;
        this.originalErr = originalErr;
        this.file = file;
        this.path = path;
        this.teeOut = new PrintStream(new TeeOutputStream(originalOut, file), true, StandardCharsets.UTF_8);
        this.teeErr = new PrintStream(new TeeOutputStream(originalErr, file), true, StandardCharsets.UTF_8);
    }

    public static FileLog install(Path directory) throws IOException {
        Path root = directory.toAbsolutePath().normalize();
        Files.createDirectories(root);
        Path path = root.resolve("roulette-bridge-" + LocalDateTime.now().format(FILE_TIME) + ".log");
        var stream = Files.newOutputStream(
            path,
            StandardOpenOption.CREATE_NEW,
            StandardOpenOption.WRITE
        );
        var file = new PrintStream(stream, true, StandardCharsets.UTF_8);
        var log = new FileLog(System.out, System.err, file, path);
        System.setOut(log.teeOut);
        System.setErr(log.teeErr);
        System.out.println("[log] " + path);
        return log;
    }

    public Path path() {
        return path;
    }

    @Override
    public synchronized void close() {
        System.setOut(originalOut);
        System.setErr(originalErr);
        teeOut.flush();
        teeErr.flush();
        file.flush();
        file.close();
    }

    private static final class TeeOutputStream extends OutputStream {
        private final OutputStream first;
        private final OutputStream second;

        private TeeOutputStream(OutputStream first, OutputStream second) {
            this.first = first;
            this.second = second;
        }

        @Override
        public synchronized void write(int value) throws IOException {
            first.write(value);
            second.write(value);
        }

        @Override
        public synchronized void write(byte[] bytes, int offset, int length) throws IOException {
            first.write(bytes, offset, length);
            second.write(bytes, offset, length);
        }

        @Override
        public synchronized void flush() throws IOException {
            first.flush();
            second.flush();
        }
    }
}
