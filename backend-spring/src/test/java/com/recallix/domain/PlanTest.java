package com.recallix.domain;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * A plan is a name now, and nothing else.
 *
 * <p>It used to carry a ceiling per tier, which meant PREMIUM -- a value no
 * account was ever sold, left on one row by an earlier build -- was unlimited.
 * The allowance is one pair of numbers for every account, in
 * UsageLimitService, so there is nothing here to assert but the parsing.
 */
class PlanTest {

    @Test
    void fromStringIsLenientAndDefaultsToFree() {
        assertEquals(Plan.PRO, Plan.fromString("pro"));
        assertEquals(Plan.PREMIUM, Plan.fromString("  PREMIUM "));
        assertEquals(Plan.FREE, Plan.fromString(null));
        assertEquals(Plan.FREE, Plan.fromString("nonsense"));
    }
}
