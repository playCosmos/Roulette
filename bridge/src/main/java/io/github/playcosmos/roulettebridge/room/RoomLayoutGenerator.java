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
        // 각 항목을 단순 floor하면 전체 비율이 100%여도 빈 칸이 생길 수 있으므로,
        // 목표 총 칸 수를 정한 뒤 largest-remainder 방식으로 정수 칸 수를 배분한다.
        int ratioBase = assignable - cursor;
        var ratioInstructions = config.instructions().stream()
            .filter(instruction -> "ratio".equals(instruction.allocation().mode()))
            .toList();

        double ratioTotal = ratioInstructions.stream()
            .mapToDouble(instruction -> instruction.allocation().value())
            .sum();

        int ratioTarget = Math.min(
            ratioBase,
            (int) Math.round(ratioBase * ratioTotal / 100.0d)
        );

        int[] ratioCounts = new int[ratioInstructions.size()];
        double[] remainders = new double[ratioInstructions.size()];
        int allocatedRatio = 0;

        for (int i = 0; i < ratioInstructions.size(); i++) {
            double exact = ratioBase
                * ratioInstructions.get(i).allocation().value()
                / 100.0d;
            int whole = (int) Math.floor(exact);
            ratioCounts[i] = whole;
            remainders[i] = exact - whole;
            allocatedRatio += whole;
        }

        var remainderOrder = new ArrayList<Integer>(ratioInstructions.size());
        for (int i = 0; i < ratioInstructions.size(); i++) remainderOrder.add(i);
        remainderOrder.sort((left, right) -> {
            int fraction = Double.compare(remainders[right], remainders[left]);
            return fraction != 0 ? fraction : Integer.compare(left, right);
        });

        int extra = Math.max(0, ratioTarget - allocatedRatio);
        for (int i = 0; i < extra && i < remainderOrder.size(); i++) {
            ratioCounts[remainderOrder.get(i)] += 1;
        }

        for (int index = 0; index < ratioInstructions.size(); index++) {
            var instruction = ratioInstructions.get(index);
            for (int i = 0; i < ratioCounts[index] && cursor < freeSlots.size(); i++) {
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

            if (isRandomCellPlaceholder(instruction)) {
                cells.add(resolveRandomCell(
                    boardIndex,
                    instruction,
                    config,
                    byId,
                    random
                ));
            } else {
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
        }

        return new BoardPreview(
            seed,
            cellCount,
            config.board().layoutStyle(),
            List.copyOf(cells),
            List.copyOf(config.randomPool().entries())
        );
    }

    private CellState resolveRandomCell(
        int boardIndex,
        InstructionInput placeholder,
        NormalizedRoomConfig config,
        Map<String, InstructionInput> byId,
        SplittableRandom random
    ) {
        var candidates = new ArrayList<RandomPoolEntry>();
        double totalWeight = 0.0d;

        for (var entry : config.randomPool().entries()) {
            var definition = byId.get(entry.instructionId());
            if (
                definition == null
                || entry.weight() <= 0.0d
                || isRandomCellPlaceholder(definition)
            ) {
                continue;
            }
            candidates.add(entry);
            totalWeight += entry.weight();
        }

        if (candidates.isEmpty() || totalWeight <= 0.0d) {
            return new CellState(
                boardIndex,
                "INSTRUCTION",
                placeholder.id(),
                placeholder.label(),
                placeholder.action() == null ? null : placeholder.action().deepCopy(),
                true,
                false
            );
        }

        double pick = random.nextDouble(totalWeight);
        RandomPoolEntry selected = candidates.get(candidates.size() - 1);
        double cursor = 0.0d;
        for (var candidate : candidates) {
            cursor += candidate.weight();
            if (pick < cursor) {
                selected = candidate;
                break;
            }
        }

        var definition = byId.get(selected.instructionId());
        return new CellState(
            boardIndex,
            "INSTRUCTION",
            definition.id(),
            definition.label(),
            resolveAction(definition.action(), random),
            true,
            false
        );
    }

    private static boolean isRandomCellPlaceholder(InstructionInput instruction) {
        if (
            instruction == null
            || !Boolean.TRUE.equals(instruction.rerollOnVacate())
            || instruction.action() == null
            || !instruction.action().isJsonObject()
        ) {
            return false;
        }

        return "randomCell".equalsIgnoreCase(
            string(instruction.action().getAsJsonObject(), "type")
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
