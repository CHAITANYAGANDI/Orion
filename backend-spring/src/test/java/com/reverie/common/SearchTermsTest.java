package com.reverie.common;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Turning typed text into a query.
 *
 * <p>Two kinds of failure matter here and they are not the obvious one. The
 * first is a search that errors: {@code to_tsquery} parses its argument, so a
 * lone apostrophe or an unbalanced bracket reaching it is a 500 on a keystroke.
 * The second is quieter — {@code !} means NOT and {@code |} means OR, so a
 * character typed as text but read as an operator returns a confidently wrong
 * answer instead of failing.
 *
 * <p>Both are tested by asserting on the constructed query rather than by
 * running SQL, because the guarantee being made is structural: no operator can
 * survive tokenising, whatever was typed.
 */
class SearchTermsTest {

    @Nested
    @DisplayName("full-text query")
    class TsQuery {

        @Test
        void makesTheLastWordAPrefix() {
            // The box is typed into a character at a time; "stri" has to find
            // "Stripe" before the word is finished or results flicker in only
            // once the user stops.
            assertThat(SearchTerms.toTsQuery("stri")).isEqualTo("stri:*");
        }

        @Test
        void andsTermsTogether() {
            // A second word is nearly always an attempt to narrow the first.
            assertThat(SearchTerms.toTsQuery("stripe invoice")).isEqualTo("stripe & invoice:*");
        }

        @Test
        void leavesEarlierTermsAsWholeWords() {
            // Only the word still being typed is a prefix. `the:*` would match
            // "there" and "their" in every meeting ever recorded.
            assertThat(SearchTerms.toTsQuery("the stripe migration"))
                    .isEqualTo("the & stripe & migration:*");
        }

        @Test
        void stripsQuerySyntaxRatherThanEscapingIt() {
            // `!` is NOT and `|` is OR. Reaching to_tsquery, either one inverts
            // or widens a search the user thought was a phrase.
            assertThat(SearchTerms.toTsQuery("!stripe | acme")).isEqualTo("stripe & acme:*");
        }

        @Test
        void survivesPunctuationThatWouldBeASyntaxError() {
            assertThat(SearchTerms.toTsQuery("what's the (Q3) plan:"))
                    .isEqualTo("what & s & the & Q3 & plan:*");
        }

        @Test
        void keepsNonLatinTerms() {
            // An ASCII-only tokenizer would reduce a Hindi or German query to
            // nothing, on an archive that is transcribed in whatever was spoken.
            assertThat(SearchTerms.toTsQuery("Preisänderung")).isEqualTo("Preisänderung:*");
            assertThat(SearchTerms.toTsQuery("बजट")).isEqualTo("बजट:*");
        }

        @Test
        void treatsDigitsAsTerms() {
            assertThat(SearchTerms.toTsQuery("Q3 2026")).isEqualTo("Q3 & 2026:*");
        }

        @Test
        void returnsEmptyForNothingSearchable() {
            // Callers must read this as "no text search", not as a query that
            // matches nothing — to_tsquery rejects an empty argument outright.
            assertThat(SearchTerms.toTsQuery("")).isEmpty();
            assertThat(SearchTerms.toTsQuery("   ")).isEmpty();
            assertThat(SearchTerms.toTsQuery("!!!")).isEmpty();
            assertThat(SearchTerms.toTsQuery(null)).isEmpty();
        }

        @Test
        void boundsTheNumberOfTerms() {
            String typed = "one two three four five six seven eight nine ten";
            String query = SearchTerms.toTsQuery(typed);

            // Each term is another AND against the index; a search this long has
            // stopped narrowing and started costing.
            assertThat(query.split(" & ")).hasSize(8);
            assertThat(query).doesNotContain("nine").doesNotContain("ten");
        }
    }

    @Nested
    @DisplayName("substring pattern")
    class Like {

        @Test
        void wrapsTheTermInWildcards() {
            // Titles and decisions are short enough that "auth" finding
            // "reauthenticate" is the point of typing four letters.
            assertThat(SearchTerms.toLike("auth")).isEqualTo("%auth%");
        }

        @Test
        void escapesWildcardsTheUserTyped() {
            // Unescaped, a search for "50%" matches every row in the table.
            assertThat(SearchTerms.toLike("50%")).isEqualTo("%50\\%%");
            assertThat(SearchTerms.toLike("q3_plan")).isEqualTo("%q3\\_plan%");
        }

        @Test
        void escapesTheEscapeCharacter() {
            assertThat(SearchTerms.toLike("a\\b")).isEqualTo("%a\\\\b%");
        }

        @Test
        void keepsPunctuationAndSpacing() {
            // Unlike the full-text query, this one is a substring match, so
            // punctuation is content rather than syntax.
            assertThat(SearchTerms.toLike("what's next?")).isEqualTo("%what's next?%");
        }

        @Test
        void returnsEmptyForNothingTyped() {
            assertThat(SearchTerms.toLike("")).isEmpty();
            assertThat(SearchTerms.toLike("   ")).isEmpty();
            assertThat(SearchTerms.toLike(null)).isEmpty();
        }
    }
}
