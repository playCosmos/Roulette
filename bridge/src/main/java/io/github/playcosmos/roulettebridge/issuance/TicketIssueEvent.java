package io.github.playcosmos.roulettebridge.issuance;

import java.util.List;

public record TicketIssueEvent(
    String type,
    String ticketId,
    String donorId,
    String nickname,
    long totalBalloons,
    int ticketNumber,
    List<Integer> numbers,
    String issuedAt
) {
    public static TicketIssueEvent create(
        String ticketId,
        String donorId,
        String nickname,
        long totalBalloons,
        int ticketNumber,
        List<Integer> numbers,
        String issuedAt
    ) {
        return new TicketIssueEvent(
            "ticket.issue",
            ticketId,
            donorId,
            nickname,
            totalBalloons,
            ticketNumber,
            List.copyOf(numbers),
            issuedAt
        );
    }
}
