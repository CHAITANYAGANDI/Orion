package com.reverie.common;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Naming a chat thread after the question that started it.
 *
 * <p>This is deliberately not a model call — see the class javadoc — so the
 * risk it carries is different from a bad generation: it is a mechanical
 * transformation that can quietly turn a question into a statement meaning
 * something else. "Did we agree to the discount?" becoming "Agree to the
 * discount" reads as a decision rather than a query, which in a list of
 * meetings-about-contracts is a genuinely misleading label.
 *
 * <p>So the tests pull in two directions: strip enough that the list is
 * scannable, strip so little that nothing changes meaning.
 */
class ConversationTitleTest {

    @ParameterizedTest
    @CsvSource(delimiter = '|', textBlock = """
        What are the action items from last week?  | Action items from last week
        what is the status of the Acme renewal?    | Status of the Acme renewal
        Show me every mention of pricing           | Every mention of pricing
        List all the open risks.                   | Open risks
        Summarize the decisions we made            | Decisions we made
        How many meetings mentioned Kafka?         | Meetings mentioned Kafka
        """)
    @DisplayName("drops the opener and keeps the subject")
    void stripsOpeners(String question, String expected) {
        assertThat(ConversationTitle.from(question)).isEqualTo(expected);
    }

    @ParameterizedTest
    @CsvSource(delimiter = '|', textBlock = """
        Who owns the migration?      | Who owns the migration
        Who signed off on the spec?  | Who signed off on the spec
        What about the budget?       | What about the budget
        Which of these is blocking?  | Which of these is blocking
        What is it about?            | What is it about
        """)
    @DisplayName("keeps an opener whose removal would leave a fragment")
    void keepsLoadBearingOpeners(String question, String expected) {
        // Two separate guards are being exercised here. "Who owns the
        // migration" keeps its opener because bare "who" is not in the strip
        // list at all — "Owns the migration" reads as a sentence with its
        // subject cut off. "Which of these is blocking" keeps its opener
        // because stripping it exposes a preposition, and "Of these is
        // blocking" is not a shorter title, it is a broken one.
        assertThat(ConversationTitle.from(question)).isEqualTo(expected);
    }

    @Test
    @DisplayName("still strips 'which' when a real subject follows")
    void stripsWhichWhenItIsPadding() {
        assertThat(ConversationTitle.from("Which meetings mentioned Kafka?"))
                .isEqualTo("Meetings mentioned Kafka");
    }

    @Test
    @DisplayName("capitalises the first letter")
    void capitalises() {
        // Lower-cased input is normal: people type questions into a chat box
        // without shifting, and a list of lower-case rows looks broken.
        assertThat(ConversationTitle.from("what are the next steps?")).isEqualTo("Next steps");
        assertThat(ConversationTitle.from("what about the budget?")).isEqualTo("What about the budget");
    }

    @Test
    @DisplayName("keeps a question that is nothing but an opener")
    void keepsShortQuestionsWhole() {
        // "What is it?" reduced to "it" is a worse title than the question, so
        // the strip is skipped when too little would be left.
        assertThat(ConversationTitle.from("What is it?")).isEqualTo("What is it");
    }

    @Test
    @DisplayName("matches an opener only at a word boundary")
    void doesNotStripMidWord() {
        // "Listen" begins with "list". Stripping on a bare prefix would leave
        // "en to the recording".
        assertThat(ConversationTitle.from("Listen to the recording")).isEqualTo("Listen to the recording");
    }

    @Test
    @DisplayName("prefers the longest matching opener")
    void longestOpenerWins() {
        // "what are" matching first would leave "the" at the front.
        assertThat(ConversationTitle.from("What are the blockers?")).isEqualTo("Blockers");
    }

    @Test
    @DisplayName("collapses whitespace and newlines")
    void collapsesWhitespace() {
        // A pasted passage arrives with line breaks, which would otherwise
        // render as a multi-line row in the picker.
        assertThat(ConversationTitle.from("What are   the\n\nnext steps?")).isEqualTo("Next steps");
    }

    @Test
    @DisplayName("truncates on a word boundary")
    void truncatesOnAWord() {
        String title = ConversationTitle.from(
                "What did the team decide about the migration timeline and the staffing plan "
                        + "for the following quarter?");
        assertThat(title).hasSizeLessThanOrEqualTo(ConversationTitle.MAX_LENGTH + 1);
        assertThat(title).endsWith("…");
        // Cut mid-word, a title reads as corrupted rather than shortened.
        assertThat(title.replace("…", "")).doesNotEndWith(" ");
        assertThat(title).doesNotContain("  ");
    }

    @Test
    @DisplayName("truncates a single very long word rather than vanishing")
    void truncatesOneLongWord() {
        // The word-boundary rule has nothing to find here; falling back to a
        // hard cut is better than an empty title.
        String title = ConversationTitle.from("a".repeat(200));
        assertThat(title).hasSizeLessThanOrEqualTo(ConversationTitle.MAX_LENGTH + 1);
        assertThat(title).isNotBlank();
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "   ", "?", "  ??  "})
    @DisplayName("falls back when there is no question")
    void fallsBack(String question) {
        assertThat(ConversationTitle.from(question)).isEqualTo(ConversationTitle.UNTITLED);
    }

    @Test
    @DisplayName("handles null")
    void handlesNull() {
        assertThat(ConversationTitle.from(null)).isEqualTo(ConversationTitle.UNTITLED);
    }

    @Test
    @DisplayName("never returns something blank")
    void neverBlank() {
        for (String q : new String[]{".", "the", "what is", "  a  ", "?!", "list"}) {
            assertThat(ConversationTitle.from(q)).isNotBlank();
        }
    }
}
