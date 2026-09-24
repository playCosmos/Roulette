package io.github.playcosmos.roulettebridge.room;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static io.github.playcosmos.roulettebridge.room.RoomModels.*;

public final class FixedInstructionCycleValidator {
    public Optional<Cycle> findCycle(BoardPreview board) {
        if (board == null || board.cells() == null || board.cells().isEmpty()) {
            return Optional.empty();
        }

        int size = board.cells().size();
        byte[] state = new byte[size];
        int[] stackIndex = new int[size];
        java.util.Arrays.fill(stackIndex, -1);

        for (int start = 0; start < size; start++) {
            if (state[start] != 0 || !isFixedMove(board.cells().get(start))) continue;

            var path = new ArrayList<Integer>();
            int current = start;

            while (current >= 0 && current < size) {
                CellState cell = board.cells().get(current);

                // 랜덤칸은 현재 지시문이 무엇이든 고정 순환 검사에서 제외한다.
                if (cell.rerollOnVacate() || !isMove(cell)) break;

                if (state[current] == 2) break;

                if (state[current] == 1) {
                    int cycleStart = stackIndex[current];
                    if (cycleStart >= 0 && cycleStart < path.size()) {
                        var indexes = new ArrayList<Integer>(
                            path.subList(cycleStart, path.size())
                        );
                        indexes.add(current);
                        return Optional.of(new Cycle(List.copyOf(indexes)));
                    }
                    break;
                }

                state[current] = 1;
                stackIndex[current] = path.size();
                path.add(current);

                int steps = resolvedMoveSteps(cell.action());
                if (steps == 0) break;

                int next = Math.floorMod(current + steps, size);
                CellState nextCell = board.cells().get(next);

                // 고정칸에서 랜덤칸으로 들어가면 이후 결과는 비결정적이므로 검사 종료.
                if (nextCell.rerollOnVacate()) break;
                current = next;
            }

            for (int index : path) {
                state[index] = 2;
                stackIndex[index] = -1;
            }
        }

        return Optional.empty();
    }

    public void requireSafe(BoardPreview board) {
        var cycle = findCycle(board);
        if (cycle.isPresent()) {
            throw new IllegalStateException(
                "fixed instruction cycle detected: " + cycle.get().describe()
            );
        }
    }

    private static boolean isFixedMove(CellState cell) {
        return cell != null
            && !cell.rerollOnVacate()
            && isMove(cell)
            && resolvedMoveSteps(cell.action()) != 0;
    }

    private static boolean isMove(CellState cell) {
        if (cell == null || cell.action() == null || !cell.action().isJsonObject()) {
            return false;
        }
        return "move".equalsIgnoreCase(text(cell.action().getAsJsonObject(), "type"));
    }

    private static int resolvedMoveSteps(JsonElement actionElement) {
        if (actionElement == null || !actionElement.isJsonObject()) return 0;

        JsonObject action = actionElement.getAsJsonObject();
        int magnitude = integer(action, "resolvedSteps", 0);

        JsonElement stepsElement = action.get("steps");
        if (magnitude <= 0 && stepsElement != null && stepsElement.isJsonObject()) {
            JsonObject steps = stepsElement.getAsJsonObject();
            if ("fixed".equalsIgnoreCase(text(steps, "mode"))) {
                magnitude = integer(steps, "value", 0);
            }
        }

        if (magnitude <= 0) return 0;
        return "backward".equalsIgnoreCase(text(action, "direction"))
            ? -magnitude
            : magnitude;
    }

    private static String text(JsonObject object, String key) {
        try {
            JsonElement value = object.get(key);
            return value != null && !value.isJsonNull() ? value.getAsString() : "";
        } catch (RuntimeException ignored) {
            return "";
        }
    }

    private static int integer(JsonObject object, String key, int fallback) {
        try {
            JsonElement value = object.get(key);
            return value != null && !value.isJsonNull() ? value.getAsInt() : fallback;
        } catch (RuntimeException ignored) {
            return fallback;
        }
    }

    public record Cycle(List<Integer> cellIndexes) {
        public String describe() {
            return cellIndexes.stream()
                .map(String::valueOf)
                .collect(java.util.stream.Collectors.joining(" -> "));
        }
    }
}
