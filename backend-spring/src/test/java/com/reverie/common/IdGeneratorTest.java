package com.reverie.common;

import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class IdGeneratorTest {

    @Test
    void generatesPrefixedIds() {
        assertTrue(IdGenerator.meeting().startsWith("mtg_"));
        assertTrue(IdGenerator.user().startsWith("usr_"));
        assertTrue(IdGenerator.actionItem().startsWith("ai_"));
    }

    @Test
    void idsAreReasonablyUnique() {
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < 10_000; i++) {
            ids.add(IdGenerator.meeting());
        }
        assertEquals(10_000, ids.size());
    }
}
