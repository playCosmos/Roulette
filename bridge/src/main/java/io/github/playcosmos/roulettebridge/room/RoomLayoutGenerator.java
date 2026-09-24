package io.github.playcosmos.roulettebridge.room;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.SplittableRandom;

import static io.github.playcosmos.roulettebridge.room.RoomModels.*;

public final class RoomLayoutGenerator {
    public BoardPreview generate(NormalizedRoomConfig config, long seed) {
        int cellCount = config.board().cellCount();
        int assignable = cellCount - 1;
        var random = new SplittableRandom(seed);

        var byId = new LinkedHashMap<String, InstructionInput>();
        for (var instruction : config.instructions()) {
            byId.put(instruction.id(), instruction);
        }

        var assignments = new ArrayList<InstructionInput>(Collections.nCopies(assignable, null));
        var freeSlots = new ArrayList<Integer>(assignable);
        for (int i = 0; i < assignable; i++) freeSlots.add(i);
        shuffle(freeSlots, random);

        int cursor = 0;

        // 고정 수량 배치를 먼저 수행한다.
        for (var instruction : config.instructions()) {
            if (!"count".equals(instruction.allocation().mode())) continue;
            int count = (int) Math.round(instruction.allocation().value());
            for (int i = 0; i < count; i++) {
                assignments.set(freeSlots.get(cursor++), instruction);
            }
        }

        // 비율 배치는 수량 배치 이후 남은 슬롯을 기준으로 계산한다.
        int ratioBase = assignable - cursor;
        for (var instruction : config.instructions()) {
            if (!"ratio".equals(instruction.allocation().mode())) continue;
            int count = (int) Math.floor(ratioBase * instruction.allocation().value() / 100.0d);
            for (int i = 0; i < count && cursor < freeSlots.size(); i++) {
                assignments.set(freeSlots.get(cursor++), instruction);
            }
        }

        var cells = new ArrayList<CellState>(cellCount);
        cells.add(new CellState(
            0,
            "START",
            "NORMAL",
            "START",
            null,
            false,
            true
        ));

        for (int boardIndex = 1; boardIndex < cellCount; boardIndex++) {
            var instruction = assignments.get(boardIndex - 1);
            if (instruction == null) {
                cells.add(new CellState(
                    boardIndex,
                    "NORMAL",
                    "NORMAL",
                    "",
                    null,
                    false,
                    false
                ));
                continue;
            }

            cells.add(new CellState(
                boardIndex,
                "INSTRUCTION",
                instruction.id(),
                instruction.label(),
                resolveAction(instruction.action(), random),
                Boolean.TRUE.equals(instruction.rerollOnVacate()),
                false
            ));
        }

        return new BoardPreview(
            seed,
            cellCount,
            config.board().layoutStyle(),
            List.copyOf(cells),
            List.copyOf(config.randomPool().entries())
        );
    }

    private JsonElement resolveAction(JsonElement action, SplittableRandom random) {
        if (action == null || action.isJsonNull() || !action.isJsonObject()) {
            return action == null ? null : action.deepCopy();
        }

        JsonObject resolved = action.deepCopy().getAsJsonObject();
        JsonElement stepsElement = resolved.get("steps");
        if (stepsElement == null || !stepsElement.isJsonObject()) return resolved;

        JsonObject steps = stepsElement.getAsJsonObject();
        String mode = string(steps, "mode");
        if (!"range".equalsIgnoreCase(mode)) return resolved;

        Integer min = integer(steps, "min");
        Integer max = integer(steps, "max");
        if (min == null || max == null || min > max) return resolved;

        int value = min == max ? min : random.nextInt(min, max + 1);
        resolved.addProperty("resolvedSteps", value);
        return resolved;
    }

    private static String string(JsonObject object, String key) {
        var value = object.get(key);
        return value != null && value.isJsonPrimitive() ? value.getAsString() : "";
    }

    private static Integer integer(JsonObject object, String key) {
        try {
            var value = object.get(key);
            return value != null && value.isJsonPrimitive() ? value.getAsInt() : null;
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private static <T> void shuffle(List<T> values, SplittableRandom random) {
        for (int i = values.size() - 1; i > 0; i--) {
            int j = random.nextInt(i + 1);
            T tmp = values.get(i);
            values.set(i, values.get(j));
            values.set(j, tmp);
        }
    }
}
