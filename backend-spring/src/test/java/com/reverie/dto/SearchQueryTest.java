package com.reverie.dto;

import com.reverie.common.ApiException;
import org.junit.jupiter.api.Test;

import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The request object, and the three things it must never let through.
 *
 * <p>A null filter, because these end up as parameters in native SQL where an
 * untyped null fails to plan rather than failing to match. An unbounded limit,
 * because {@code ?limit=100000} is a full table read per group. And an "empty"
 * search that is not actually empty — a filter with no words in the box is a
 * real question, and answering it with the browse view would silently ignore
 * what the user asked for.
 */
class SearchQueryTest {

    /** Named arguments, so a thirteen-field record does not have to be counted. */
    private static Builder q() {
        return new Builder();
    }

    private static final class Builder {
        private String text = "";
        private Set<String> groups;
        private int limit = 5;
        private int offset;
        private String from = "";
        private String to = "";
        private String project = "";
        private String speaker = "";
        private boolean withDecisions;

        Builder text(String v) { this.text = v; return this; }
        Builder groups(Set<String> v) { this.groups = v; return this; }
        Builder limit(int v) { this.limit = v; return this; }
        Builder offset(int v) { this.offset = v; return this; }
        Builder from(String v) { this.from = v; return this; }
        Builder to(String v) { this.to = v; return this; }
        Builder project(String v) { this.project = v; return this; }
        Builder speaker(String v) { this.speaker = v; return this; }
        Builder withDecisions() { this.withDecisions = true; return this; }

        SearchQuery build() {
            return new SearchQuery(text, groups, limit, offset, from, to,
                    "", "", "", project, speaker, "", withDecisions);
        }
    }

    @Test
    void turnsEveryAbsentFilterIntoAnEmptyString() {
        SearchQuery s = new SearchQuery("stripe", null, 5, 0,
                null, null, null, null, null, null, null, null, false);

        assertThat(s.from()).isEmpty();
        assertThat(s.to()).isEmpty();
        assertThat(s.status()).isEmpty();
        assertThat(s.type()).isEmpty();
        assertThat(s.tag()).isEmpty();
        assertThat(s.project()).isEmpty();
        assertThat(s.speaker()).isEmpty();
        assertThat(s.owner()).isEmpty();
    }

    @Test
    void trimsWhatWasTyped() {
        assertThat(q().text("  stripe  ").build().text()).isEqualTo("stripe");
        assertThat(q().text(null).build().text()).isEmpty();
    }

    @Test
    void defaultsToEveryGroup() {
        assertThat(q().text("stripe").build().groups()).isEqualTo(SearchQuery.ALL_GROUPS);
        assertThat(q().groups(Set.of()).build().groups()).isEqualTo(SearchQuery.ALL_GROUPS);
    }

    @Test
    void keepsAnExplicitGroupSelection() {
        SearchQuery s = q().text("stripe").groups(Set.of("mentions")).limit(50).build();

        assertThat(s.wants("mentions")).isTrue();
        assertThat(s.wants("meetings")).isFalse();
    }

    @Test
    void boundsTheLimit() {
        assertThat(q().limit(100_000).build().limit()).isEqualTo(SearchQuery.MAX_LIMIT);
        assertThat(q().limit(0).build().limit()).isEqualTo(1);
        assertThat(q().offset(-20).build().offset()).isZero();
    }

    @Test
    void keepsAValidDateBoundExactlyAsSent() {
        // Parsed to check it, then discarded: the query casts the caller's own
        // string, so there is no round trip through Instant to shift it.
        SearchQuery s = q().from("2026-08-01T00:00:00Z").to("2026-08-15T23:59:59Z").build();

        assertThat(s.from()).isEqualTo("2026-08-01T00:00:00Z");
        assertThat(s.to()).isEqualTo("2026-08-15T23:59:59Z");
    }

    @Test
    void rejectsADateItCannotCast() {
        // Unchecked, `?from=last-tuesday` reaches Postgres, fails the cast and
        // comes back a 500 — a server error for a plainly bad request.
        assertThatThrownBy(() -> q().from("last-tuesday").build())
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("ISO-8601");
    }

    @Test
    void countsAFilterAsASearch() {
        // "Everything from last week where Priya spoke" has no words in it and
        // is still a question. Treating it as empty would answer a different one.
        SearchQuery filtered = q().speaker("Priya").build();

        assertThat(filtered.isEmpty()).isFalse();
        assertThat(filtered.hasFilters()).isTrue();
    }

    @Test
    void countsAProjectAsAFilter() {
        // Including the one that means "filed nowhere" — "what have I not sorted
        // yet" is a search, not an empty box.
        assertThat(q().project("prj_1").build().hasFilters()).isTrue();
        assertThat(q().project("none").build().isEmpty()).isFalse();
    }

    @Test
    void isEmptyOnlyWithNeitherTextNorFilters() {
        assertThat(q().build().isEmpty()).isTrue();
        assertThat(q().text("stripe").build().isEmpty()).isFalse();
        assertThat(q().withDecisions().build().isEmpty()).isFalse();
    }
}
