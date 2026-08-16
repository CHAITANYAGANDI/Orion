package com.recallix.domain;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * How hard the chat should look.
 *
 * <p>Small enough to be obviously right, and worth pinning anyway for one
 * reason: the default has to stay express. A client that does not send the field
 * — which is every client written before the picker existed, and every internal
 * caller that has no picker to read — must get precisely the behaviour it had,
 * not the slower and more expensive one.
 */
class ChatModeTest {

    @Test
    @DisplayName("nothing means express, which is what the chat always did")
    void defaultsToExpress() {
        assertThat(ChatMode.of(null)).isEqualTo(ChatMode.EXPRESS);
        assertThat(ChatMode.of("")).isEqualTo(ChatMode.EXPRESS);
        assertThat(ChatMode.of("   ")).isEqualTo(ChatMode.EXPRESS);
    }

    @Test
    @DisplayName("reads a value however it was cased or spaced")
    void tolerant() {
        assertThat(ChatMode.of("advanced")).isEqualTo(ChatMode.ADVANCED);
        assertThat(ChatMode.of("  ADVANCED ")).isEqualTo(ChatMode.ADVANCED);
    }

    @Test
    @DisplayName("answers the question rather than refusing an unknown mode")
    void unknownFallsBack() {
        // A value from a newer build. Answering with the safe default beats
        // failing a question somebody asked.
        assertThat(ChatMode.of("turbo")).isEqualTo(ChatMode.EXPRESS);
    }

    @Test
    @DisplayName("goes over the wire in the spelling the ai-service accepts")
    void wireFormat() {
        assertThat(ChatMode.EXPRESS.wire()).isEqualTo("express");
        assertThat(ChatMode.ADVANCED.wire()).isEqualTo("advanced");
    }

    @Test
    @DisplayName("describes itself, so the picker's wording cannot drift from the behaviour")
    void describesItself() {
        assertThat(ChatMode.EXPRESS.label()).isEqualTo("Express");
        assertThat(ChatMode.EXPRESS.hint()).contains("speed");
        assertThat(ChatMode.ADVANCED.hint()).contains("in-depth");
    }
}
