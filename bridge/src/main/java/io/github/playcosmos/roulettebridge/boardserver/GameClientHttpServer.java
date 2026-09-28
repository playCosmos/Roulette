package io.github.playcosmos.roulettebridge.boardserver;

import com.google.gson.Gson;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.github.playcosmos.roulettebridge.room.BoardGameRuntimeEngine;
import io.github.playcosmos.roulettebridge.room.RoomService;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;

public final class GameClientHttpServer implements AutoCloseable {
    private static final Gson GSON = new Gson();
    private static final SecureRandom SECURE_RANDOM = new SecureRandom();
    private static final Base64.Encoder TOKEN_ENCODER =
        Base64.getUrlEncoder().withoutPadding();
    private static final String SESSION_COOKIE = "RAMYANI_ADMIN_SESSION";
    private static final Duration SESSION_TTL = Duration.ofHours(12);
    private static final Duration APPROVAL_TTL = Duration.ofMinutes(10);
    private static final int MAX_PENDING_APPROVALS = 32;
    private static final String APPROVAL_ALPHABET =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    private static final int MAX_PROXY_BODY_BYTES = 1024 * 1024;

    private final HttpServer server;
    private final Path webRoot;
    private final RoomService rooms;
    private final BoardGameRuntimeEngine runtime;
    private final BoardServerConfig config;
    private final HttpClient adminHttpClient;
    private final URI adminBaseUri;
    private final AdminAuthStore adminAuthStore;
    private final AtomicReference<String> adminBootstrapToken;

    public GameClientHttpServer(
        BoardServerConfig config,
        Path workingDirectory,
        RoomService rooms,
        BoardGameRuntimeEngine runtime,
        AdminAuthStore adminAuthStore
    ) throws IOException {
        var normalized = config.normalized();
        this.config = normalized;
        this.webRoot = resolveWebRoot(
            workingDirectory,
            normalized.storage().webRoot()
        );
        this.rooms = rooms;
        this.runtime = runtime;
        this.adminAuthStore = adminAuthStore;
        try {
            this.adminBootstrapToken = new AtomicReference<>(
                adminAuthStore.bootstrapTokenOrCreate(
                    () -> randomToken(24)
                )
            );
        } catch (java.sql.SQLException error) {
            throw new IOException(
                "failed to initialize persistent admin authentication",
                error
            );
        }
        this.adminHttpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3))
            .build();
        this.adminBaseUri = URI.create(
            "http://127.0.0.1:" + normalized.server().port()
        );
        this.server = HttpServer.create(
            new InetSocketAddress(
                normalized.server().clientHost(),
                normalized.server().clientPort()
            ),
            0
        );
        this.server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());

        server.createContext("/health", this::health);
        server.createContext("/api/client/config", this::clientConfig);
        server.createContext("/api/state", this::proxyAdminState);
        server.createContext("/api/board/rooms", this::boardRooms);
        server.createContext("/games/board/", this::serveBoardAsset);
        server.createContext("/api/admin/access", this::adminAccess);
        server.createContext("/admin", this::serveAdmin);
        server.createContext("/", exchange -> {
            exchange.sendResponseHeaders(404, -1);
            exchange.close();
        });
    }

    public void start() {
        server.start();
        System.out.println(
            "[game-client-http] listening on http://"
                + server.getAddress().getHostString()
                + ":" + server.getAddress().getPort()
        );
    }

    public String adminBootstrapUrl() {
        String base = config.server().publicBaseUrl();
        if (base == null || base.isBlank()) {
            base = localAdminBootstrapBaseUrl();
        }
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        return base + "/admin/?token="
            + encodedAdminBootstrapToken();
    }

    public String localAdminBootstrapUrl() {
        return localAdminBootstrapBaseUrl()
            + "/admin/?token="
            + encodedAdminBootstrapToken();
    }

    private String localAdminBootstrapBaseUrl() {
        return "http://127.0.0.1:" + config.server().clientPort();
    }

    private String encodedAdminBootstrapToken() {
        return URLEncoder.encode(
            adminBootstrapToken.get(),
            StandardCharsets.UTF_8
        );
    }

    public int activeAdminSessionCount() {
        try {
            return adminAuthStore.countActiveSessions(
                Instant.now()
            );
        } catch (java.sql.SQLException error) {
            System.err.println(
                "[admin-auth] session count failed: "
                    + error.getMessage()
            );
            return 0;
        }
    }

    public int pendingAdminApprovalCount() {
        try {
            return adminAuthStore.countPendingApprovalRequests(
                Instant.now()
            );
        } catch (java.sql.SQLException error) {
            System.err.println(
                "[admin-auth] approval count failed: "
                    + error.getMessage()
            );
            return 0;
        }
    }

    public boolean approveAdminAccess(String approvalCode) {
        try {
            return adminAuthStore.approveApprovalRequest(
                approvalCode,
                Instant.now()
            );
        } catch (java.sql.SQLException error) {
            throw new IllegalStateException(
                "failed to approve administrator access",
                error
            );
        }
    }

    public int revokeAdminSessions() {
        try {
            return adminAuthStore.revokeAllSessions();
        } catch (java.sql.SQLException error) {
            throw new IllegalStateException(
                "failed to revoke admin sessions",
                error
            );
        }
    }

    public String rotateAdminAccess() {
        String nextToken = randomToken(24);
        try {
            adminAuthStore.rotateBootstrapToken(nextToken);
            adminBootstrapToken.set(nextToken);
            return adminBootstrapUrl();
        } catch (java.sql.SQLException error) {
            throw new IllegalStateException(
                "failed to rotate admin access",
                error
            );
        }
    }

    private void health(HttpExchange exchange) throws IOException {
        if (!requireGetOrHead(exchange)) return;
        sendJson(exchange, 200, Map.of(
            "status", "ok",
            "product", "RamyaniGamesClient",
            "time", OffsetDateTime.now().toString()
        ));
    }

    private void clientConfig(HttpExchange exchange) throws IOException {
        corsPublic(exchange);
        if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
            return;
        }
        if (!requireGetOrHead(exchange)) return;

        sendJson(exchange, 200, Map.of(
            "websocketUrl",
            resolvedWebSocketUrl(exchange)
        ));
    }

    private void proxyAdminState(HttpExchange exchange) throws IOException {
        if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
            return;
        }
        if (!isAdminSession(exchange)) {
            sendJson(exchange, 401, Map.of(
                "error",
                "administrator authentication required"
            ));
            return;
        }
        proxyToLocalAdmin(exchange);
    }

    private void boardRooms(HttpExchange exchange) throws IOException {
        corsPublic(exchange);
        if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
            return;
        }

        String method = exchange.getRequestMethod();
        if (
            "GET".equalsIgnoreCase(method)
            || "HEAD".equalsIgnoreCase(method)
        ) {
            readRoom(exchange);
            return;
        }

        if (!isAdminSession(exchange)) {
            sendJson(exchange, 401, Map.of(
                "error",
                "administrator authentication required"
            ));
            return;
        }

        proxyToLocalAdmin(exchange);
    }

    private void readRoom(HttpExchange exchange) throws IOException {
        String base = "/api/board/rooms/";
        String path = exchange.getRequestURI().getPath();
        if (
            path == null
            || !path.startsWith(base)
            || path.length() <= base.length()
        ) {
            sendJson(exchange, 404, Map.of("error", "room not found"));
            return;
        }

        String route = path.substring(base.length());
        boolean runtimeRoute = route.endsWith("/runtime");
        String roomId;

        if (runtimeRoute) {
            roomId = route.substring(
                0,
                route.length() - "/runtime".length()
            );
        } else {
            if (route.contains("/")) {
                sendJson(
                    exchange,
                    404,
                    Map.of("error", "route not found")
                );
                return;
            }
            roomId = route;
        }

        if (!hasRoomReadAccess(exchange, roomId)) {
            sendJson(exchange, 401, Map.of(
                "error",
                "valid committed room code required"
            ));
            return;
        }

        try {
            Object payload = runtimeRoute
                ? runtime.snapshot(roomId)
                : rooms.find(roomId);

            if ("HEAD".equalsIgnoreCase(exchange.getRequestMethod())) {
                exchange.sendResponseHeaders(200, -1);
                exchange.close();
                return;
            }
            sendJson(exchange, 200, payload);
        } catch (Exception error) {
            sendJson(
                exchange,
                error instanceof java.util.NoSuchElementException ? 404 : 400,
                Map.of("error", safeMessage(error))
            );
        }
    }

    private boolean hasRoomReadAccess(
        HttpExchange exchange,
        String roomId
    ) {
        if (isAdminSession(exchange)) return true;

        String normalizedRoomId = normalizeRoomCode(roomId);
        String suppliedRoomCode = normalizeRoomCode(
            queryParameter(
                exchange.getRequestURI().getRawQuery(),
                "roomCode"
            )
        );

        if (
            normalizedRoomId.length() != 6
            || suppliedRoomCode.length() != 6
            || !constantTimeEquals(
                suppliedRoomCode,
                normalizedRoomId
            )
        ) {
            return false;
        }

        try {
            var room = rooms.find(normalizedRoomId);
            var lifecycle = room.lifecycle();
            if (!"READY".equals(room.status()) || lifecycle == null) {
                return false;
            }

            String state = lifecycle.state();
            return "ACTIVE".equals(state) || "PAUSED".equals(state);
        } catch (Exception error) {
            return false;
        }
    }

    private static String normalizeRoomCode(String value) {
        return value == null
            ? ""
            : value.trim().toUpperCase(Locale.ROOT);
    }

    private void serveAdmin(HttpExchange exchange) throws IOException {
        String path = exchange.getRequestURI().getPath();
        if (
            path == null
            || !("/admin".equals(path) || path.startsWith("/admin/"))
        ) {
            exchange.sendResponseHeaders(404, -1);
            exchange.close();
            return;
        }

        String suppliedToken = queryParameter(
            exchange.getRequestURI().getRawQuery(),
            "token"
        );
        if (isAdminSession(exchange)) {
            if (suppliedToken != null) {
                redirectAfterAuthentication(exchange);
                return;
            }
        } else {
            if (acceptBootstrapToken(exchange)) {
                return;
            }
            sendAdminAuthenticationRequired(exchange, "");
            return;
        }

        if ("/admin".equals(path) || "/admin/".equals(path)) {
            redirect(exchange, "/admin/board-admin.html");
            return;
        }

        String relative = path.substring("/admin/".length());
        if (!isAllowedAdminAsset(relative)) {
            exchange.sendResponseHeaders(404, -1);
            exchange.close();
            return;
        }

        serveFile(
            exchange,
            webRoot.resolve(relative).normalize(),
            webRoot
        );
    }

    private boolean acceptBootstrapToken(
        HttpExchange exchange
    ) throws IOException {
        String supplied = queryParameter(
            exchange.getRequestURI().getRawQuery(),
            "token"
        );
        if (supplied == null) return false;

        if (!constantTimeEquals(supplied, adminBootstrapToken.get())) {
            sendAdminAuthenticationRequired(
                exchange,
                "입력한 관리자 토큰이 올바르지 않습니다."
            );
            return true;
        }

        String sessionId = randomToken(32);
        try {
            adminAuthStore.createSession(
                sessionId,
                Instant.now().plus(SESSION_TTL)
            );
        } catch (java.sql.SQLException error) {
            sendJson(
                exchange,
                500,
                Map.of("error", "administrator session storage failed")
            );
            return true;
        }

        setAdminSessionCookie(exchange, sessionId);
        redirectAfterAuthentication(exchange);
        return true;
    }

    private void redirectAfterAuthentication(
        HttpExchange exchange
    ) throws IOException {
        String path = exchange.getRequestURI().getPath();
        if ("/admin".equals(path) || "/admin/".equals(path)) {
            redirect(exchange, "/admin/board-admin.html");
            return;
        }
        redirect(
            exchange,
            path + queryWithoutToken(
                exchange.getRequestURI().getRawQuery()
            )
        );
    }

    private void setAdminSessionCookie(
        HttpExchange exchange,
        String sessionId
    ) {
        StringBuilder cookie = new StringBuilder();
        cookie.append(SESSION_COOKIE)
            .append("=")
            .append(sessionId)
            .append("; Path=/; Max-Age=")
            .append(SESSION_TTL.toSeconds())
            .append("; HttpOnly; SameSite=Strict");
        if (isSecurePublicRequest(exchange)) {
            cookie.append("; Secure");
        }
        exchange.getResponseHeaders().add(
            "Set-Cookie",
            cookie.toString()
        );
    }

    private boolean isAdminSession(HttpExchange exchange) {
        String cookie = exchange.getRequestHeaders().getFirst("Cookie");
        if (cookie == null || cookie.isBlank()) return false;

        for (String item : cookie.split(";")) {
            String value = item.trim();
            int equals = value.indexOf('=');
            if (equals <= 0) continue;
            if (!SESSION_COOKIE.equals(value.substring(0, equals))) {
                continue;
            }

            String sessionId = value.substring(equals + 1);
            try {
                Instant now = Instant.now();
                Instant expiresAt =
                    adminAuthStore.sessionExpiresAt(sessionId);
                if (
                    expiresAt == null
                    || !expiresAt.isAfter(now)
                ) {
                    if (expiresAt != null) {
                        adminAuthStore.deleteSession(sessionId);
                    }
                    return false;
                }

                adminAuthStore.refreshSession(
                    sessionId,
                    now.plus(SESSION_TTL)
                );
                return true;
            } catch (java.sql.SQLException error) {
                System.err.println(
                    "[admin-auth] session validation failed: "
                        + error.getMessage()
                );
                return false;
            }
        }
        return false;
    }

    private void adminAccess(HttpExchange exchange) throws IOException {
        String path = exchange.getRequestURI().getPath();
        if ("/api/admin/access/request".equals(path)) {
            createAdminApprovalRequest(exchange);
            return;
        }
        if ("/api/admin/access/status".equals(path)) {
            pollAdminApprovalRequest(exchange);
            return;
        }
        exchange.sendResponseHeaders(404, -1);
        exchange.close();
    }

    private void createAdminApprovalRequest(
        HttpExchange exchange
    ) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(405, -1);
            exchange.close();
            return;
        }
        if (isAdminSession(exchange)) {
            sendJson(exchange, 200, Map.of(
                "status", "AUTHENTICATED",
                "redirect", "/admin/board-admin.html"
            ));
            return;
        }

        try {
            Instant now = Instant.now();
            int pending = adminAuthStore.countPendingApprovalRequests(now);
            if (pending >= MAX_PENDING_APPROVALS) {
                sendJson(exchange, 429, Map.of(
                    "error", "too many pending administrator approvals"
                ));
                return;
            }

            String requestId = randomToken(24);
            String approvalCode = "";
            boolean created = false;
            Instant expiresAt = now.plus(APPROVAL_TTL);
            for (int attempt = 0; attempt < 32; attempt += 1) {
                approvalCode = randomApprovalCode();
                if (adminAuthStore.createApprovalRequest(
                    requestId,
                    approvalCode,
                    expiresAt
                )) {
                    created = true;
                    break;
                }
            }

            if (!created) {
                sendJson(exchange, 503, Map.of(
                    "error", "failed to allocate administrator approval code"
                ));
                return;
            }

            sendJson(exchange, 201, Map.of(
                "status", "PENDING",
                "requestId", requestId,
                "approvalCode", approvalCode,
                "expiresAt", expiresAt.toString(),
                "expiresInSeconds", APPROVAL_TTL.toSeconds()
            ));
        } catch (java.sql.SQLException error) {
            sendJson(exchange, 500, Map.of(
                "error", "administrator approval storage failed"
            ));
        }
    }

    private void pollAdminApprovalRequest(
        HttpExchange exchange
    ) throws IOException {
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(405, -1);
            exchange.close();
            return;
        }
        if (isAdminSession(exchange)) {
            sendJson(exchange, 200, Map.of(
                "status", "AUTHENTICATED",
                "redirect", "/admin/board-admin.html"
            ));
            return;
        }

        String requestId = queryParameter(
            exchange.getRequestURI().getRawQuery(),
            "requestId"
        );
        if (
            requestId == null
            || requestId.length() < 20
            || requestId.length() > 160
        ) {
            sendJson(exchange, 400, Map.of(
                "error", "valid requestId is required"
            ));
            return;
        }

        try {
            Instant now = Instant.now();
            var request = adminAuthStore.findApprovalRequest(
                requestId,
                now
            );
            if (request == null) {
                sendJson(exchange, 410, Map.of(
                    "status", "EXPIRED"
                ));
                return;
            }

            if (!"APPROVED".equals(request.status())) {
                sendJson(exchange, 200, Map.of(
                    "status", request.status(),
                    "approvalCode", request.code(),
                    "expiresAt", request.expiresAt().toString()
                ));
                return;
            }

            String sessionId = randomToken(32);
            boolean consumed =
                adminAuthStore.consumeApprovedApprovalRequest(
                    requestId,
                    sessionId,
                    now.plus(SESSION_TTL),
                    now
                );
            if (!consumed) {
                sendJson(exchange, 409, Map.of(
                    "status", "EXPIRED"
                ));
                return;
            }

            setAdminSessionCookie(exchange, sessionId);
            sendJson(exchange, 200, Map.of(
                "status", "APPROVED",
                "redirect", "/admin/board-admin.html"
            ));
        } catch (java.sql.SQLException error) {
            sendJson(exchange, 500, Map.of(
                "error", "administrator approval status failed"
            ));
        }
    }

    private void proxyToLocalAdmin(HttpExchange exchange) throws IOException {
        byte[] requestBody = exchange.getRequestBody()
            .readNBytes(MAX_PROXY_BODY_BYTES + 1);
        if (requestBody.length > MAX_PROXY_BODY_BYTES) {
            sendJson(exchange, 413, Map.of(
                "error",
                "administrator request exceeds 1 MiB"
            ));
            return;
        }

        String target = exchange.getRequestURI().getRawPath();
        String query = exchange.getRequestURI().getRawQuery();
        if (query != null && !query.isBlank()) {
            target += "?" + query;
        }

        HttpRequest.BodyPublisher bodyPublisher =
            requestBody.length == 0
                ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofByteArray(requestBody);

        var builder = HttpRequest.newBuilder(
            adminBaseUri.resolve(target)
        )
            .timeout(Duration.ofSeconds(15))
            .method(exchange.getRequestMethod(), bodyPublisher)
            .header("Accept", "application/json");

        String contentType = exchange.getRequestHeaders().getFirst(
            "Content-Type"
        );
        if (contentType != null && !contentType.isBlank()) {
            builder.header("Content-Type", contentType);
        }

        try {
            var response = adminHttpClient.send(
                builder.build(),
                HttpResponse.BodyHandlers.ofByteArray()
            );

            String responseType = response.headers()
                .firstValue("Content-Type")
                .orElse("application/json; charset=utf-8");
            exchange.getResponseHeaders().set(
                "Content-Type",
                responseType
            );
            exchange.getResponseHeaders().set(
                "Cache-Control",
                "no-store"
            );

            byte[] body = response.body();
            if (
                "HEAD".equalsIgnoreCase(exchange.getRequestMethod())
                || response.statusCode() == 204
            ) {
                exchange.sendResponseHeaders(
                    response.statusCode(),
                    -1
                );
                exchange.close();
                return;
            }

            exchange.sendResponseHeaders(
                response.statusCode(),
                body.length
            );
            try (var output = exchange.getResponseBody()) {
                output.write(body);
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            sendJson(exchange, 503, Map.of(
                "error",
                "administrator service interrupted"
            ));
        } catch (Exception error) {
            sendJson(exchange, 502, Map.of(
                "error",
                "administrator service unavailable"
            ));
        }
    }

    private void serveBoardAsset(HttpExchange exchange) throws IOException {
        if (!requireGetOrHead(exchange)) return;

        String rawPath = exchange.getRequestURI().getPath();
        String decoded = URLDecoder.decode(
            rawPath == null ? "" : rawPath,
            StandardCharsets.UTF_8
        );

        if (!decoded.startsWith("/games/board/")) {
            exchange.sendResponseHeaders(404, -1);
            exchange.close();
            return;
        }

        Path requested = webRoot
            .resolve(decoded.substring(1))
            .normalize();
        Path allowedRoot = webRoot.resolve("games/board").normalize();

        serveFile(exchange, requested, allowedRoot);
    }

    private static void serveFile(
        HttpExchange exchange,
        Path requested,
        Path allowedRoot
    ) throws IOException {
        if (
            !requested.startsWith(allowedRoot)
            || !Files.isRegularFile(requested)
        ) {
            exchange.sendResponseHeaders(404, -1);
            exchange.close();
            return;
        }

        byte[] body = Files.readAllBytes(requested);
        exchange.getResponseHeaders().set(
            "Content-Type",
            contentType(requested)
        );
        exchange.getResponseHeaders().set(
            "Cache-Control",
            "no-cache"
        );

        if ("HEAD".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
            return;
        }

        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(405, -1);
            exchange.close();
            return;
        }

        exchange.sendResponseHeaders(200, body.length);
        try (var output = exchange.getResponseBody()) {
            output.write(body);
        }
    }

    private static boolean isAllowedAdminAsset(String relative) {
        return "board-admin.html".equals(relative)
            || "board-room.html".equals(relative)
            || relative.startsWith("soop/admin/")
            || relative.startsWith("games/board/");
    }

    private String resolvedWebSocketUrl(HttpExchange exchange) {
        String configured = config.server().publicWebSocketUrl();
        if (configured != null && !configured.isBlank()) {
            return configured;
        }

        String host = exchange.getRequestHeaders().getFirst(
            "X-Forwarded-Host"
        );
        if (host == null || host.isBlank()) {
            host = exchange.getRequestHeaders().getFirst("Host");
        }
        if (host == null || host.isBlank()) {
            host = "127.0.0.1";
        }

        int comma = host.indexOf(',');
        if (comma >= 0) {
            host = host.substring(0, comma).trim();
        }

        String hostname = host;
        if (host.startsWith("[")) {
            int close = host.indexOf(']');
            if (close > 0) {
                hostname = host.substring(0, close + 1);
            }
        } else {
            int colon = host.lastIndexOf(':');
            if (colon > 0 && host.indexOf(':') == colon) {
                hostname = host.substring(0, colon);
            }
        }

        String forwardedProto = exchange.getRequestHeaders().getFirst(
            "X-Forwarded-Proto"
        );
        String scheme = forwardedProto != null
            && forwardedProto.trim().equalsIgnoreCase("https")
            ? "wss"
            : "ws";

        return scheme + "://" + hostname
            + ":" + config.server().websocketPort();
    }

    private boolean isSecurePublicRequest(HttpExchange exchange) {
        if (
            config.server().publicBaseUrl() != null
            && config.server().publicBaseUrl().startsWith("https://")
        ) {
            return true;
        }
        String forwarded = exchange.getRequestHeaders().getFirst(
            "X-Forwarded-Proto"
        );
        return forwarded != null
            && forwarded.trim().equalsIgnoreCase("https");
    }

    private static boolean requireGetOrHead(
        HttpExchange exchange
    ) throws IOException {
        if (
            "GET".equalsIgnoreCase(exchange.getRequestMethod())
            || "HEAD".equalsIgnoreCase(exchange.getRequestMethod())
        ) {
            return true;
        }
        exchange.sendResponseHeaders(405, -1);
        exchange.close();
        return false;
    }

    private static Path resolveWebRoot(
        Path workingDirectory,
        String configured
    ) {
        Path path = Path.of(configured);
        return (
            path.isAbsolute()
                ? path
                : workingDirectory.resolve(path)
        )
            .toAbsolutePath()
            .normalize();
    }

    private static String randomToken(int byteCount) {
        byte[] bytes = new byte[byteCount];
        SECURE_RANDOM.nextBytes(bytes);
        return TOKEN_ENCODER.encodeToString(bytes);
    }

    private static String randomApprovalCode() {
        StringBuilder code = new StringBuilder(6);
        for (int index = 0; index < 6; index += 1) {
            code.append(
                APPROVAL_ALPHABET.charAt(
                    SECURE_RANDOM.nextInt(APPROVAL_ALPHABET.length())
                )
            );
        }
        return code.toString();
    }

    private static boolean constantTimeEquals(
        String left,
        String right
    ) {
        return MessageDigest.isEqual(
            left.getBytes(StandardCharsets.UTF_8),
            right.getBytes(StandardCharsets.UTF_8)
        );
    }

    private static String queryParameter(
        String rawQuery,
        String name
    ) {
        if (rawQuery == null || rawQuery.isBlank()) return null;
        for (String pair : rawQuery.split("&")) {
            int equals = pair.indexOf('=');
            String rawName = equals >= 0
                ? pair.substring(0, equals)
                : pair;
            if (!name.equals(URLDecoder.decode(
                rawName,
                StandardCharsets.UTF_8
            ))) {
                continue;
            }
            String rawValue = equals >= 0
                ? pair.substring(equals + 1)
                : "";
            return URLDecoder.decode(
                rawValue,
                StandardCharsets.UTF_8
            );
        }
        return null;
    }

    private static String queryWithoutToken(String rawQuery) {
        if (rawQuery == null || rawQuery.isBlank()) return "";

        var kept = new ArrayList<String>();
        for (String pair : rawQuery.split("&")) {
            int equals = pair.indexOf('=');
            String rawName = equals >= 0
                ? pair.substring(0, equals)
                : pair;
            if ("token".equals(URLDecoder.decode(
                rawName,
                StandardCharsets.UTF_8
            ))) {
                continue;
            }
            kept.add(pair);
        }
        return kept.isEmpty() ? "" : "?" + String.join("&", kept);
    }

    private static void sendAdminAuthenticationRequired(
        HttpExchange exchange,
        String errorMessage
    ) throws IOException {
        String error = errorMessage == null || errorMessage.isBlank()
            ? ""
            : "<p class=\"error\">"
                + escapeHtml(errorMessage)
                + "</p>";
        String html = """
            <!doctype html>
            <html lang="ko">
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width, initial-scale=1">
              <meta name="color-scheme" content="dark">
              <title>Ramyani Games Server · 관리자 인증</title>
              <style>
                *{box-sizing:border-box}
                body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0d11;color:#d8dee7;font-family:system-ui,sans-serif}
                main{width:min(620px,calc(100% - 32px));padding:24px;border:1px solid #303842;border-radius:16px;background:#11161d}
                h1{margin:0 0 10px;font-size:22px}
                h2{margin:22px 0 7px;font-size:15px}
                p{margin:0;color:#929dab;line-height:1.65;font-size:13px}
                form,.approval-actions{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;margin-top:10px}
                input{min-width:0;padding:11px 12px;border:1px solid #303944;border-radius:9px;background:#0b0f14;color:#e7ebf0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
                button{padding:10px 13px;border:1px solid #3b4856;border-radius:9px;background:#19222c;color:#e8edf3;font-weight:800;cursor:pointer}
                button:disabled{opacity:.55;cursor:wait}
                .tag{display:inline-block;margin-bottom:12px;padding:4px 8px;border:1px solid #4b5f73;border-radius:999px;color:#a7bfd6;font-size:11px;font-weight:800}
                .section{margin-top:18px;padding-top:17px;border-top:1px solid #272f38}
                .error{margin-top:12px;color:#e6a0a4}
                .approval{display:none;margin-top:12px;padding:14px;border:1px solid #394858;border-radius:10px;background:#0d131a}
                .approval[data-visible="true"]{display:block}
                .approval-code{margin:7px 0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:30px;font-weight:900;letter-spacing:.18em;color:#dfe8f2}
                .status{margin-top:8px;color:#a6b4c2}
                @media(max-width:520px){form,.approval-actions{grid-template-columns:1fr}}
              </style>
            </head>
            <body>
              <main>
                <span class="tag">ADMIN</span>
                <h1>관리자 인증</h1>
                <p>인증 링크를 받은 경우 그대로 접속할 수 있습니다. 링크 대신 토큰 값만 전달받았다면 아래에 직접 입력할 수도 있습니다.</p>
                """ + error + """
                <section class="section">
                  <h2>관리자 토큰 입력</h2>
                  <form method="get" action="/admin/">
                    <input name="token" autocomplete="off" spellcheck="false" required placeholder="관리자 토큰" aria-label="관리자 토큰">
                    <button type="submit">토큰으로 인증</button>
                  </form>
                </section>
                <section class="section">
                  <h2>토큰이 없는 경우</h2>
                  <p>승인 요청을 만들면 10분 동안 유효한 6자리 코드가 생성됩니다. 이 코드를 서버 관리자에게 알려주세요.</p>
                  <div class="approval-actions">
                    <button type="button" id="requestApproval">6자리 승인 코드 요청</button>
                  </div>
                  <div class="approval" id="approvalBox">
                    <p>서버 관리자에게 아래 코드를 전달하세요.</p>
                    <div class="approval-code" id="approvalCode">------</div>
                    <p class="status" id="approvalStatus">승인 대기 중…</p>
                  </div>
                </section>
              </main>
              <script>
              (() => {
                const button = document.getElementById("requestApproval");
                const box = document.getElementById("approvalBox");
                const code = document.getElementById("approvalCode");
                const status = document.getElementById("approvalStatus");
                const storageKey = "ramyani.adminApproval.v1";
                let timer = 0;

                function clearSaved() {
                  sessionStorage.removeItem(storageKey);
                }

                function saveRequest(value) {
                  sessionStorage.setItem(storageKey, JSON.stringify(value));
                }

                function showRequest(value) {
                  box.dataset.visible = "true";
                  code.textContent = value.approvalCode || "------";
                  status.textContent = "서버 관리자 승인 대기 중…";
                  button.disabled = true;
                }

                async function poll(value) {
                  window.clearTimeout(timer);
                  try {
                    const response = await fetch(
                      "/api/admin/access/status?requestId="
                        + encodeURIComponent(value.requestId),
                      { cache: "no-store" }
                    );
                    const body = await response.json().catch(() => ({}));
                    if (body.status === "APPROVED" || body.status === "AUTHENTICATED") {
                      clearSaved();
                      status.textContent = "승인되었습니다. 관리자 페이지로 이동합니다.";
                      window.location.replace(body.redirect || "/admin/board-admin.html");
                      return;
                    }
                    if (body.status === "EXPIRED" || response.status === 410) {
                      clearSaved();
                      status.textContent = "승인 코드가 만료되었습니다. 새 코드를 요청하세요.";
                      button.disabled = false;
                      return;
                    }
                    if (!response.ok) {
                      throw new Error(body.error || ("HTTP " + response.status));
                    }
                    if (body.approvalCode) {
                      value.approvalCode = body.approvalCode;
                      saveRequest(value);
                      code.textContent = body.approvalCode;
                    }
                    timer = window.setTimeout(() => poll(value), 1500);
                  } catch (error) {
                    status.textContent = "승인 상태 확인 실패 · 자동 재시도 중";
                    timer = window.setTimeout(() => poll(value), 3000);
                  }
                }

                button.addEventListener("click", async () => {
                  button.disabled = true;
                  status.textContent = "승인 코드 생성 중…";
                  try {
                    const response = await fetch("/api/admin/access/request", {
                      method: "POST",
                      headers: { "Accept": "application/json" }
                    });
                    const body = await response.json().catch(() => ({}));
                    if (body.status === "AUTHENTICATED") {
                      window.location.replace(body.redirect || "/admin/board-admin.html");
                      return;
                    }
                    if (!response.ok) {
                      throw new Error(body.error || ("HTTP " + response.status));
                    }
                    const value = {
                      requestId: body.requestId,
                      approvalCode: body.approvalCode,
                      expiresAt: body.expiresAt
                    };
                    saveRequest(value);
                    showRequest(value);
                    poll(value);
                  } catch (error) {
                    box.dataset.visible = "true";
                    code.textContent = "------";
                    status.textContent = "승인 요청 실패: " + error.message;
                    button.disabled = false;
                  }
                });

                try {
                  const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
                  if (saved?.requestId) {
                    showRequest(saved);
                    poll(saved);
                  }
                } catch (_) {
                  clearSaved();
                }

                window.addEventListener("beforeunload", () => {
                  window.clearTimeout(timer);
                }, { once: true });
              })();
              </script>
            </body>
            </html>
            """;

        byte[] body = html.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set(
            "Content-Type",
            "text/html; charset=utf-8"
        );
        exchange.getResponseHeaders().set(
            "Cache-Control",
            "no-store"
        );
        exchange.sendResponseHeaders(401, body.length);
        try (var output = exchange.getResponseBody()) {
            output.write(body);
        }
    }

    private static String escapeHtml(String value) {
        return String.valueOf(value)
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\"", "&quot;")
            .replace("'", "&#39;");
    }

    private static void redirect(
        HttpExchange exchange,
        String location
    ) throws IOException {
        exchange.getResponseHeaders().set("Location", location);
        exchange.getResponseHeaders().set(
            "Cache-Control",
            "no-store"
        );
        exchange.sendResponseHeaders(303, -1);
        exchange.close();
    }

    private static String contentType(Path path) {
        String name = path.getFileName().toString().toLowerCase();
        if (name.endsWith(".html")) {
            return "text/html; charset=utf-8";
        }
        if (name.endsWith(".js")) {
            return "text/javascript; charset=utf-8";
        }
        if (name.endsWith(".css")) {
            return "text/css; charset=utf-8";
        }
        if (name.endsWith(".json")) {
            return "application/json; charset=utf-8";
        }
        if (name.endsWith(".svg")) return "image/svg+xml";
        if (name.endsWith(".png")) return "image/png";
        if (
            name.endsWith(".jpg")
            || name.endsWith(".jpeg")
        ) {
            return "image/jpeg";
        }
        if (name.endsWith(".webp")) return "image/webp";
        if (name.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    private static void corsPublic(HttpExchange exchange) {
        exchange.getResponseHeaders().set(
            "Access-Control-Allow-Origin",
            "*"
        );
        exchange.getResponseHeaders().set(
            "Access-Control-Allow-Methods",
            "GET, HEAD, OPTIONS"
        );
        exchange.getResponseHeaders().set(
            "Access-Control-Allow-Headers",
            "Content-Type"
        );
    }

    private static void sendJson(
        HttpExchange exchange,
        int status,
        Object payload
    ) throws IOException {
        byte[] body = GSON.toJson(payload)
            .getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set(
            "Content-Type",
            "application/json; charset=utf-8"
        );
        exchange.getResponseHeaders().set(
            "Cache-Control",
            "no-store"
        );
        exchange.sendResponseHeaders(status, body.length);
        try (var output = exchange.getResponseBody()) {
            output.write(body);
        }
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isBlank()
            ? error.getClass().getSimpleName()
            : message;
    }

    @Override
    public void close() {
        server.stop(1);
    }
}
