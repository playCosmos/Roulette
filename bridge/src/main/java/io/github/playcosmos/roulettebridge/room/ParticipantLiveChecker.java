package io.github.playcosmos.roulettebridge.room;

import java.util.List;

import static io.github.playcosmos.roulettebridge.room.RoomModels.PlayerConfig;

@FunctionalInterface
public interface ParticipantLiveChecker {
    List<PlayerConfig> check(List<PlayerConfig> players);
}
