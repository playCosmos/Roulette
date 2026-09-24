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
        RulesInput rules,
        List<InstructionInput> instructions,
        RandomPoolInput randomPool,
        Integer retentionMinutes,
        String pauseDonationMode
    ) {
        public CreateRoomRequest(
            String name,
            List<PlayerInput> players,
            BoardInput board,
            MovementInput movement,
            RulesInput rules,
            List<InstructionInput> instructions,
            RandomPoolInput randomPool
        ) {
            this(
                name,
                players,
                board,
                movement,
                rules,
                instructions,
                randomPool,
                null,
                null,
                null
            );
        }
    }

    public record PlayerInput(
        String soopId,
        String displayName,
        String profileImageUrl,
        int balloonTrigger
    ) {}

    public record PlayerLiveStatus(
        String status,
        String bno,
        String title,
        String checkedAt,
        String error
    ) {}

    public record PlayerConfig(
        String soopId,
        String displayName,
        String profileImageUrl,
        int balloonTrigger,
        PlayerLiveStatus live
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

    public record RulesInput(
        String landingInstructionMode,
        Boolean resolveLandingBeforeBonusThrow,
        Boolean skipNextThrowConsumesBonus
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
        List<PlayerConfig> players,
        BoardConfig board,
        MovementConfig movement,
        RulesConfig rules,
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

    public record RulesConfig(
        String landingInstructionMode,
        boolean resolveLandingBeforeBonusThrow,
        boolean skipNextThrowConsumesBonus
    ) {}

    public record RandomPoolConfig(
        String mode,
        List<RandomPoolEntry> entries,
        Boolean allowSameInstruction
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

    public record RoomLifecycle(
        String state,
        int retentionMinutes,
        String expiresAt,
        String pauseDonationMode,
        int pauseGraceSeconds,
        String pauseRequestedAt,
        String pauseGraceUntil,
        int queuedDonations,
        String terminatedAt
    ) {}

    public record RoomSnapshot(
        String roomId,
        String status,
        NormalizedRoomConfig config,
        BoardPreview preview,
        BoardPreview committedBoard,
        String createdAt,
        String updatedAt,
        RoomLifecycle lifecycle
    ) {
        public RoomSnapshot(
            String roomId,
            String status,
            NormalizedRoomConfig config,
            BoardPreview preview,
            BoardPreview committedBoard,
            String createdAt,
            String updatedAt
        ) {
            this(
                roomId,
                status,
                config,
                preview,
                committedBoard,
                createdAt,
                updatedAt,
                null
            );
        }
    }

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
