package com.recallix.common;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Placing a quoted sentence in the recording.
 *
 * <p>The link this produces is presented as evidence — "here is where they said
 * it" — so the failure that matters is not a missing link but a confident one
 * pointing at the wrong moment. Every test that expects null is guarding that.
 */
class SentenceLocatorTest {

    private static final List<SentenceLocator.Line> TRANSCRIPT = List.of(
            new SentenceLocator.Line(0.0, "Right, shall we start?"),
            new SentenceLocator.Line(12.5, "Yeah."),
            new SentenceLocator.Line(31.0,
                    "So Chaitanya will finish the JWT validation by Friday, and then we can ship."),
            new SentenceLocator.Line(64.2, "Marcus is drafting the rollout plan this week."),
            new SentenceLocator.Line(90.0, "Yeah."));

    private static Double locate(String sentence) {
        return SentenceLocator.locate(sentence, TRANSCRIPT);
    }

    @Test
    @DisplayName("a sentence quoted out of a line is found in that line")
    void findsAQuotedFragment() {
        assertThat(locate("Chaitanya will finish the JWT validation by Friday")).isEqualTo(31.0);
    }

    @Test
    @DisplayName("punctuation and casing are not evidence")
    void ignoresShape() {
        // The extractor re-punctuates freely; requiring an exact match would
        // find nothing on a real transcript.
        assertThat(locate("chaitanya will finish the jwt validation, by friday!")).isEqualTo(31.0);
    }

    @Test
    @DisplayName("a quote spanning more than the line is still placed at its start")
    void findsWhenTheQuoteIsLonger() {
        assertThat(locate("Marcus is drafting the rollout plan this week and will circulate it"))
                .isEqualTo(64.2);
    }

    @Test
    @DisplayName("a line that wholly contains the quote wins over one that merely overlaps")
    void prefersContainment() {
        List<SentenceLocator.Line> lines = List.of(
                new SentenceLocator.Line(5.0, "Marcus is drafting the rollout plan"),
                new SentenceLocator.Line(80.0,
                        "I think Marcus is drafting the rollout plan this week, isn't he?"));

        // The second line is the better answer even though it is later, because
        // it holds the whole sentence rather than part of it.
        assertThat(SentenceLocator.locate("Marcus is drafting the rollout plan this week", lines))
                .isEqualTo(80.0);
    }

    @Test
    @DisplayName("a sentence too short to be distinctive is not placed at all")
    void refusesShortSentences() {
        // "Yeah" occurs at 12.5 and again at 90.0 and means nothing at either.
        assertThat(locate("Yeah.")).isNull();
        assertThat(locate("Sounds good")).isNull();
    }

    @Test
    @DisplayName("a sentence that is not in the transcript is not placed")
    void refusesAbsentSentences() {
        assertThat(locate("We agreed to postpone the migration until next quarter")).isNull();
    }

    @Test
    @DisplayName("a short line is not matched just because the quote contains it")
    void shortLinesDoNotSwallowLongQuotes() {
        List<SentenceLocator.Line> lines = List.of(
                new SentenceLocator.Line(3.0, "the"),
                new SentenceLocator.Line(9.0, "Nothing relevant was said here at all."));

        assertThat(SentenceLocator.locate("Chaitanya will finish the JWT validation", lines)).isNull();
    }

    @Test
    @DisplayName("nothing to search, nothing to find")
    void handlesEmptyInput() {
        assertThat(SentenceLocator.locate("Chaitanya will finish the JWT validation", List.of())).isNull();
        assertThat(SentenceLocator.locate(null, TRANSCRIPT)).isNull();
    }

    @Test
    @DisplayName("a line with no timing cannot answer, even if it matches")
    void skipsUntimedLines() {
        List<SentenceLocator.Line> lines = List.of(
                new SentenceLocator.Line(null, "Chaitanya will finish the JWT validation by Friday."));

        assertThat(SentenceLocator.locate("Chaitanya will finish the JWT validation", lines)).isNull();
    }
}
