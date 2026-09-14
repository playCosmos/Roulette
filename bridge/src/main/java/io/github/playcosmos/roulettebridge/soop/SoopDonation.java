package io.github.playcosmos.roulettebridge.soop;

public record SoopDonation(
    String streamerId,
    String donorId,
    String nickname,
    int balloonCount,
    int fanOrder,
    String rawPayload,
    long receivedAtEpochMs
) {}
