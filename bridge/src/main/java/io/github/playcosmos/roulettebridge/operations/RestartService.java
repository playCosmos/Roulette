package io.github.playcosmos.roulettebridge.operations;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;

public final class RestartService {
    private static final long EXIT_DELAY_MILLIS = 4000;

    private final Path applicationRoot;
    private final AtomicBoolean scheduled = new AtomicBoolean(false);

    public RestartService(Path applicationRoot) {
        this.applicationRoot = Objects.requireNonNull(applicationRoot, "applicationRoot").toAbsolutePath().normalize();
    }

    public RestartResult schedule() throws IOException {
        if (!scheduled.compareAndSet(false, true)) {
            return new RestartResult(true, "restart already scheduled", applicationRoot.resolve("RouletteBridge.exe").toString());
        }

        Path executable = applicationRoot.resolve("RouletteBridge.exe");
        Path script = applicationRoot.resolve("restart-bridge.ps1");
        if (!Files.isRegularFile(executable)) {
            scheduled.set(false);
            return new RestartResult(false, "packaged executable not found; restart manually in development mode", executable.toString());
        }
        if (!Files.isRegularFile(script)) {
            scheduled.set(false);
            throw new IOException("restart script not found: " + script);
        }

        long pid = ProcessHandle.current().pid();
        var command = List.of(
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
            "-WindowStyle", "Hidden",
            "-File", script.toString(),
            "-ParentPid", Long.toString(pid),
            "-Executable", executable.toString()
        );
        new ProcessBuilder(command)
            .directory(applicationRoot.toFile())
            .redirectInput(ProcessBuilder.Redirect.DISCARD)
            .redirectOutput(ProcessBuilder.Redirect.DISCARD)
            .redirectError(ProcessBuilder.Redirect.DISCARD)
            .start();

        // Config saving happens on the HTTP request thread. Give the 200 response and
        // browser-side save handling enough time to complete before terminating this
        // process; otherwise the file is saved correctly but the admin page can see a
        // network abort and incorrectly report "저장 실패".
        Thread.ofPlatform().name("roulette-bridge-restart-exit").start(() -> {
            try {
                Thread.sleep(EXIT_DELAY_MILLIS);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            System.exit(0);
        });

        return new RestartResult(true, "restart scheduled", executable.toString());
    }

    public record RestartResult(boolean scheduled, String message, String executable) {}
}
