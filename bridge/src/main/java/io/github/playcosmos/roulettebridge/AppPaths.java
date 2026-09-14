package io.github.playcosmos.roulettebridge;

import java.nio.file.Path;

public final class AppPaths {
    private AppPaths() {}

    public static Path applicationRoot() {
        String override = System.getenv("ROULETTE_BRIDGE_HOME");
        if (override != null && !override.isBlank()) {
            return Path.of(override).toAbsolutePath().normalize();
        }

        String packagedLauncher = System.getProperty("jpackage.app-path");
        if (packagedLauncher != null && !packagedLauncher.isBlank()) {
            Path launcher = Path.of(packagedLauncher).toAbsolutePath().normalize();
            Path parent = launcher.getParent();
            if (parent != null) return parent;
        }

        return Path.of("").toAbsolutePath().normalize();
    }

    public static Path resolveConfig(Path applicationRoot, String configuredPath) {
        Path path = Path.of(configuredPath);
        return path.isAbsolute()
            ? path.normalize()
            : applicationRoot.resolve(path).normalize();
    }
}
