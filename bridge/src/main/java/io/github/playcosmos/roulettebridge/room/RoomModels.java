package io.github.playcosmos.roulettebridge.room;

import com.google.gson.JsonElement;
import java.util.List;
import java.util.Map;

public final class RoomModels {
    private RoomModels() {}

    public record CreateRoomRequest(
        String name,
        List<PlayerInput> players,
        BoardInput board,
        MovementInput movement,
        List<InstructionInput> instructions,
        RandomPoolInput randomPool
    ) {}

    public record PlayerInput(
        String soopId,
        String displayName,
        String profileImageUrl,
        int balloonTrigger
    ) {}

    public record BoardInput(
        String sizingMode,
        Integer columns,
        Integer rows,
        Integer cellCount,
        String layoutStyle
    ) {}

    public record MovementInput(
        String generator,
        Integer diceCount,
        Boolean extraThrowOnDouble,
        Boolean extraThrowOnYut,
        Boolean extraThrowOnMo
    ) {}

    public record InstructionInput(
        String id,
        String label,
        AllocationInput allocation,
        Boolean rerollOnVacate,
        JsonElement action
    ) {}

    public record AllocationInput(
        String mode,
        double value
    ) {}

    public record RandomPoolInput(
        String mode,
        List<RandomPoolEntry> entries,
        Boolean allowSameInstruction
    ) {}

    public record RandomPoolEntry(
        String instructionId,
        double weight
    ) {}

    public record NormalizedRoomConfig(
        String name,
        List<PlayerInput> players,
        BoardConfig board,
        MovementConfig movement,
        List<InstructionInput> instructions,
        RandomPoolConfig randomPool
    ) {}

    public record BoardConfig(
        int columns,
        int rows,
        int cellCount,
        String layoutStyle
    ) {}

    public record MovementConfig(
        String generator,
        int diceCount,
        int diceSides,
        boolean extraThrowOnDouble,
        boolean extraThrowOnYut,
        boolean extraThrowOnMo
    ) {}

    public record RandomPoolConfig(
        String mode,
        List<RandomPoolEntry> entries,
        boolean allowSameInstruction
    ) {}

    public record BoardPreview(
        long seed,
        int cellCount,
        String layoutStyle,
        List<CellState> cells,
        List<RandomPoolEntry> rerollPool
    ) {}

    public record CellState(
        int index,
        String type,
        String instructionId,
        String label,
        JsonElement action,
        boolean rerollOnVacate,
        boolean locked
    ) {}

    public record RoomSnapshot(
        String roomId,
        String status,
        NormalizedRoomConfig config,
        BoardPreview preview,
        BoardPreview committedBoard,
        String createdAt,
        String updatedAt
    ) {}

    public record ValidationError(String field, String message) {}

    public record ValidationResult(
        NormalizedRoomConfig config,
        List<ValidationError> errors
    ) {
        public boolean valid() {
            return errors == null || errors.isEmpty();
        }
    }

    public static Map<String, Object> error(String message) {
        return Map.of("error", message);
    }
}
