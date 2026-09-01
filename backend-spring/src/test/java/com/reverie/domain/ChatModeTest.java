package com.reverie.domain;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * How hard the chat should look.
 *
 * <p>Small enough to be obviously right, and worth pinning anyway for two
 * reasons. The default has to stay the narrow one: a client that does not send
 * the field — which is every client written before the picker existed, and every
 * internal caller that has no picker to read — must get precisely the behaviour
 * it had, not the slower and more expensive one.
 *
 * <p>And the constants no longer match the wire. They were EXPRESS and ADVANCED,
 * which are the words the ai-service still speaks; the labels became Quick and
 * Thorough because the old pair named two different axes and implied the fast
 * one was the stupid one. The mapping between the two spellings is the thing
 * most likely to be "tidied" by somebody who has not read this, so it is
 * asserted in both directions.
 */
class ChatModeTest {

    @Test
    @DisplayName("nothing means Quick, which is what the chat always did")
    void defaultsToQuick() {
        assertThat(ChatMode.of(null)).isEqualTo(ChatMode.QUICK);
        assertThat(ChatMode.of("")).isEqualTo(ChatMode.QUICK);
        assertThat(ChatMode.of("   ")).isEqualTo(ChatMode.QUICK);
    }

    @Test
    @DisplayName("reads a value however it was cased or spaced")
    void tolerant() {
        assertThat(ChatMode.of("advanced")).isEqualTo(ChatMode.THOROUGH);
        assertThat(ChatMode.of("  ADVANCED ")).isEqualTo(ChatMode.THOROUGH);
    }

    @Test
    @DisplayName("reads the constant's name as well as the wire word")
    void readsBothSpellings() {
        // The client echoes back whatever /chat/modes gave it, which is the
        // wire word -- but a tab open across the rename is holding the previous
        // answer, and something reading the enum's own name is an easy mistake
        // to make. Both resolve rather than silently falling back to Quick,
        // which would look like the picker ignoring the choice.
        assertThat(ChatMode.of("thorough")).isEqualTo(ChatMode.THOROUGH);
        assertThat(ChatMode.of("THOROUGH")).isEqualTo(ChatMode.THOROUGH);
        assertThat(ChatMode.of("quick")).isEqualTo(ChatMode.QUICK);
        assertThat(ChatMode.of("express")).isEqualTo(ChatMode.QUICK);
    }

    @Test
    @DisplayName("answers the question rather than refusing an unknown mode")
    void unknownFallsBack() {
        // A value from a newer build. Answering with the safe default beats
        // failing a question somebody asked.
        assertThat(ChatMode.of("turbo")).isEqualTo(ChatMode.QUICK);
    }

    @Test
    @DisplayName("goes over the wire in the spelling the ai-service accepts")
    void wireFormat() {
        assertThat(ChatMode.QUICK.wire()).isEqualTo("express");
        assertThat(ChatMode.THOROUGH.wire()).isEqualTo("advanced");
    }

    @Test
    @DisplayName("describes itself, so the picker's wording cannot drift from the behaviour")
    void describesItself() {
        assertThat(ChatMode.QUICK.label()).isEqualTo("Quick");
        assertThat(ChatMode.THOROUGH.label()).isEqualTo("Thorough");
        assertThat(ChatMode.QUICK.hint()).contains("strongest evidence");
        assertThat(ChatMode.THOROUGH.hint()).contains("lists what it finds");
    }

    @Test
    @DisplayName("the two names sit on one axis, not two")
    void namesAreOneAxis() {
        // Express is a claim about speed, Advanced a claim about capability.
        // Together they read as fast-and-basic against slow-and-clever, which
        // is not the choice on offer: both see the same complete ledgers, and
        // the only difference is how much transcript is read around them.
        for (ChatMode mode : ChatMode.values()) {
            assertThat(mode.label())
                    .isNotEqualTo("Express")
                    .isNotEqualTo("Advanced");
        }
    }

    @Test
    @DisplayName("neither mode is sold as the accurate one")
    void neitherPromisesAccuracy() {
        // The hints used to read "Balanced for accuracy and speed" against "For
        // in-depth analysis and actions", which together imply the quick one
        // may be wrong. It may not: both modes obey the same grounding rules
        // and are held to the same evidence. What differs is how much of the
        // archive is read. A reader who believes otherwise pays for the slow
        // one on every question they care about, which is a tax on a promise
        // nobody meant to make.
        for (ChatMode mode : ChatMode.values()) {
            assertThat(mode.hint().toLowerCase())
                    .doesNotContain("accurate")
                    .doesNotContain("accuracy")
                    .doesNotContain("better");
        }
    }
}
