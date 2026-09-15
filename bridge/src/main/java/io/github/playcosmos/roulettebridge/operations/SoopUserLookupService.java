package io.github.playcosmos.roulettebridge.operations;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;

public final class SoopUserLookupService {
    private static final Gson GSON = new Gson();
    private static final String SEARCH_ENDPOINT = "https://sch.sooplive.com/api.php";
    private static final int MAX_CANDIDATES = 10;

    private final HttpClient http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .followRedirects(HttpClient.Redirect.NORMAL)
        .build();

    public LookupResult lookup(String value, String field) throws Exception {
        String query = required(value, "value", 120);
        String normalizedField = normalizeField(field);
        String url = SEARCH_ENDPOINT
            + "?m=searchHistory&service=list&d="
            + URLEncoder.encode(query, StandardCharsets.UTF_8);

        var request = HttpRequest.newBuilder(URI.create(url))
            .timeout(Duration.ofSeconds(8))
            .header("Accept", "application/json")
            .header("User-Agent", "RouletteBridge/0.1")
            .GET()
            .build();
        var response = http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new IllegalStateException("SOOP 사용자 조회 실패 (HTTP " + response.statusCode() + ")");
        }

        JsonObject root = GSON.fromJson(response.body(), JsonObject.class);
        JsonArray source = root == null ? null : array(root, "suggest_bj", "suggestBj", "users", "data");
        var candidates = new ArrayList<UserCandidate>();
        if (source != null) {
            for (JsonElement element : source) {
                if (!element.isJsonObject()) continue;
                JsonObject item = element.getAsJsonObject();
                String id = text(item, "user_id", "userId", "bj_id", "bjId", "id");
                String nickname = text(item, "user_nick", "userNick", "nickname", "nick");
                if (id == null || id.isBlank() || nickname == null || nickname.isBlank()) continue;
                String logo = text(item, "station_logo", "stationLogo", "profile_image", "profileImage");
                candidates.add(new UserCandidate(id.trim(), nickname.trim(), logo));
                if (candidates.size() >= MAX_CANDIDATES) break;
            }
        }

        UserCandidate exact = findExact(candidates, query, normalizedField);
        return new LookupResult(
            query,
            normalizedField,
            exact != null,
            exact,
            List.copyOf(candidates),
            SEARCH_ENDPOINT
        );
    }

    private static UserCandidate findExact(List<UserCandidate> candidates, String query, String field) {
        for (var candidate : candidates) {
            if ("id".equals(field) && equalsId(candidate.donorId(), query)) return candidate;
            if ("nickname".equals(field) && candidate.nickname().equals(query)) return candidate;
        }
        if ("auto".equals(field)) {
            for (var candidate : candidates) {
                if (equalsId(candidate.donorId(), query) || candidate.nickname().equals(query)) return candidate;
            }
        }
        return null;
    }

    private static boolean equalsId(String left, String right) {
        return left != null && right != null && left.toLowerCase(Locale.ROOT).equals(right.toLowerCase(Locale.ROOT));
    }

    private static String normalizeField(String field) {
        if (field == null || field.isBlank()) return "auto";
        return switch (field.trim().toLowerCase(Locale.ROOT)) {
            case "id", "donorid", "user_id" -> "id";
            case "nickname", "nick", "user_nick" -> "nickname";
            default -> "auto";
        };
    }

    private static JsonArray array(JsonObject object, String... keys) {
        for (String key : keys) {
            if (!object.has(key) || object.get(key).isJsonNull()) continue;
            JsonElement value = object.get(key);
            if (value.isJsonArray()) return value.getAsJsonArray();
            if (value.isJsonObject()) {
                JsonObject nested = value.getAsJsonObject();
                for (String nestedKey : List.of("list", "items", "users", "data")) {
                    if (nested.has(nestedKey) && nested.get(nestedKey).isJsonArray()) {
                        return nested.getAsJsonArray(nestedKey);
                    }
                }
            }
        }
        return null;
    }

    private static String text(JsonObject object, String... keys) {
        for (String key : keys) {
            if (!object.has(key) || object.get(key).isJsonNull()) continue;
            try {
                String value = object.get(key).getAsString();
                if (value != null && !value.isBlank()) return value;
            } catch (Exception ignored) {
                // Try the next compatible field name.
            }
        }
        return null;
    }

    private static String required(String value, String name, int maxLength) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
        String trimmed = value.trim();
        if (trimmed.length() > maxLength) throw new IllegalArgumentException(name + " is too long");
        return trimmed;
    }

    public record UserCandidate(String donorId, String nickname, String profileImage) {}

    public record LookupResult(
        String query,
        String field,
        boolean resolved,
        UserCandidate match,
        List<UserCandidate> candidates,
        String source
    ) {}
}
