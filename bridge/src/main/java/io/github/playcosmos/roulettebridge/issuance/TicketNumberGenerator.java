package io.github.playcosmos.roulettebridge.issuance;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;

public final class TicketNumberGenerator {
    private final SecureRandom random = new SecureRandom();

    public List<Integer> generate(int numberMax, int numberCount) {
        if (numberMax <= 0) throw new IllegalArgumentException("numberMax must be positive");
        if (numberCount <= 0 || numberCount > numberMax) {
            throw new IllegalArgumentException("numberCount must be between 1 and numberMax");
        }

        var pool = new ArrayList<Integer>(numberMax);
        for (int value = 1; value <= numberMax; value++) pool.add(value);

        for (int i = pool.size() - 1; i > 0; i--) {
            int j = random.nextInt(i + 1);
            var temp = pool.get(i);
            pool.set(i, pool.get(j));
            pool.set(j, temp);
        }

        return List.copyOf(pool.subList(0, numberCount));
    }
}
