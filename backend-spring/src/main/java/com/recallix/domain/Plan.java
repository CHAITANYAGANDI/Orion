package com.recallix.domain;

/**
 * Subscription plans with their monthly meeting/AI-minute limits.
 * -1 means unlimited. Matches api-contracts §5.
 */
public enum Plan {
    FREE(5, 60),
    PRO(50, 600),
    PREMIUM(-1, -1);

    private final int meetingsLimit;
    private final int aiMinutesLimit;

    Plan(int meetingsLimit, int aiMinutesLimit) {
        this.meetingsLimit = meetingsLimit;
        this.aiMinutesLimit = aiMinutesLimit;
    }

    public int meetingsLimit() {
        return meetingsLimit;
    }

    public int aiMinutesLimit() {
        return aiMinutesLimit;
    }

    public boolean isUnlimited() {
        return meetingsLimit < 0;
    }

    public static Plan fromString(String value) {
        if (value == null) {
            return FREE;
        }
        try {
            return Plan.valueOf(value.trim().toUpperCase());
        } catch (IllegalArgumentException e) {
            return FREE;
        }
    }
}
