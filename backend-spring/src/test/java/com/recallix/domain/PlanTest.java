package com.recallix.domain;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PlanTest {

    @Test
    void limitsMatchContract() {
        assertEquals(5, Plan.FREE.meetingsLimit());
        assertEquals(60, Plan.FREE.aiMinutesLimit());
        assertEquals(50, Plan.PRO.meetingsLimit());
        assertEquals(600, Plan.PRO.aiMinutesLimit());
        assertTrue(Plan.PREMIUM.isUnlimited());
        assertFalse(Plan.FREE.isUnlimited());
    }

    @Test
    void fromStringIsLenientAndDefaultsToFree() {
        assertEquals(Plan.PRO, Plan.fromString("pro"));
        assertEquals(Plan.PREMIUM, Plan.fromString("  PREMIUM "));
        assertEquals(Plan.FREE, Plan.fromString(null));
        assertEquals(Plan.FREE, Plan.fromString("nonsense"));
    }
}
