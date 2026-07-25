package com.recallix.dto;

import java.time.Instant;

public record UsageResponse(
        String plan,
        Instant periodStart,
        Instant periodEnd,
        int meetingsUsed,
        int meetingsLimit,   // -1 = unlimited
        int aiMinutesUsed,
        int aiMinutesLimit   // -1 = unlimited
) {
}
