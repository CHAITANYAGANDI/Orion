package com.reverie.service;

import com.reverie.domain.MeetingStatus;
import com.reverie.dto.SearchQuery;
import com.reverie.dto.SearchResponse;
import com.reverie.dto.SearchResponse.SearchGroup;
import com.reverie.entity.Meeting;
import com.reverie.repository.MeetingRepository;
import com.reverie.repository.SearchRepository;
import com.reverie.repository.SearchRepository.MeetingMatch;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.time.Instant;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Which queries a search actually runs.
 *
 * <p>The SQL itself is verified against a real database — these are native
 * queries and mocking them proves nothing about whether they parse. What is
 * worth pinning down here is the decision layer above them, where the failures
 * are expensive rather than wrong: an empty box scanning every table in the
 * workspace, a full-text query built from punctuation, or a result linking to a
 * meeting that has since been deleted.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class WorkspaceSearchServiceTest {

    private static final String USER = "usr_1";

    @Mock private SearchRepository search;
    @Mock private MeetingRepository meetings;

    private WorkspaceSearchService service;

    @BeforeEach
    void setUp() {
        service = new WorkspaceSearchService(search, meetings);
        when(search.meetings(anyString(), any(), anyString(), anyString()))
                .thenReturn(SearchGroup.empty());
        when(search.people(anyString(), any(), anyString())).thenReturn(SearchGroup.empty());
        when(search.insights(anyString(), any(), anyString(), anyString()))
                .thenReturn(SearchGroup.empty());
        when(search.commitments(anyString(), any(), anyString())).thenReturn(SearchGroup.empty());
        when(search.mentions(anyString(), any(), anyString())).thenReturn(SearchGroup.empty());
    }

    private static SearchQuery query(String text) {
        return new SearchQuery(text, null, 5, 0, "", "", "", "", "", "", "", "", false);
    }

    private static Meeting meeting(String id, String title) {
        Meeting m = new Meeting();
        m.setId(id);
        m.setUserId(USER);
        m.setTitle(title);
        m.setStatus(MeetingStatus.READY);
        m.setCreatedAt(Instant.parse("2026-08-01T10:00:00Z"));
        return m;
    }

    @Test
    void anEmptyBoxListsRecentMeetingsAndScansNothingElse() {
        service.search(USER, query(""));

        verify(search).meetings(eq(USER), any(), eq(""), eq(""));
        verify(search, never()).people(anyString(), any(), anyString());
        verify(search, never()).insights(anyString(), any(), anyString(), anyString());
        verify(search, never()).commitments(anyString(), any(), anyString());
        verify(search, never()).mentions(anyString(), any(), anyString());
    }

    @Test
    void aFilterAloneIsStillASearch() {
        // No words typed, but "everything Priya spoke in" is a question, and
        // answering it with the browse view would ignore the filter.
        SearchQuery filtered = new SearchQuery("", null, 5, 0,
                "", "", "", "", "", "", "Priya", "", false);

        service.search(USER, filtered);

        verify(search).people(eq(USER), any(), eq(""));
        verify(search).commitments(eq(USER), any(), eq(""));
    }

    @Test
    void asksForDecisionsAndRisksSeparately() {
        service.search(USER, query("stripe"));

        verify(search).insights(eq(USER), any(), anyString(), eq("DECISION"));
        verify(search).insights(eq(USER), any(), anyString(), eq("RISK"));
    }

    @Test
    void skipsTheFullTextQueryWhenNothingSearchableWasTyped() {
        // to_tsquery parses its argument and rejects an empty one; "???" leaves
        // no term behind, so the mention query has nothing to run.
        service.search(USER, query("???"));

        verify(search, never()).mentions(anyString(), any(), anyString());
        // The other groups still run — "???" is a legitimate substring search.
        verify(search).commitments(eq(USER), any(), eq("%???%"));
    }

    @Test
    void runsOnlyTheGroupThatWasAskedFor() {
        // "See all 27 transcript mentions" should not re-run four queries whose
        // results it will not show.
        service.search(USER, new SearchQuery("stripe", Set.of("mentions"), 50, 0,
                "", "", "", "", "", "", "", "", false));

        verify(search).mentions(eq(USER), any(), eq("stripe:*"));
        verify(search, never()).meetings(anyString(), any(), anyString(), anyString());
        verify(search, never()).people(anyString(), any(), anyString());
    }

    @Test
    void attachesLiveMetadataToMatchedMeetings() {
        when(search.meetings(anyString(), any(), anyString(), anyString()))
                .thenReturn(new SearchGroup<>(1, List.of(new MeetingMatch("mtg_1", 4, true))));
        when(meetings.findAllById(any())).thenReturn(List.of(meeting("mtg_1", "Q3 Planning")));

        SearchResponse res = service.search(USER, query("stripe"));

        assertThat(res.meetings().hits()).singleElement().satisfies(hit -> {
            assertThat(hit.title()).isEqualTo("Q3 Planning");
            assertThat(hit.status()).isEqualTo("READY");
            // Why this meeting is in the results, shown on the row itself.
            assertThat(hit.mentions()).isEqualTo(4);
            assertThat(hit.titleMatch()).isTrue();
        });
    }

    @Test
    void dropsAMeetingDeletedSinceItMatched() {
        when(search.meetings(anyString(), any(), anyString(), anyString()))
                .thenReturn(new SearchGroup<>(2, List.of(
                        new MeetingMatch("mtg_1", 1, false),
                        new MeetingMatch("mtg_gone", 3, false))));
        when(meetings.findAllById(any())).thenReturn(List.of(meeting("mtg_1", "Q3 Planning")));

        SearchResponse res = service.search(USER, query("stripe"));

        // A row that links to nothing is worse than a row that is not there.
        assertThat(res.meetings().hits()).hasSize(1);
        assertThat(res.meetings().hits().getFirst().id()).isEqualTo("mtg_1");
    }

    @Test
    void keepsTheOrderTheSearchChose() {
        when(search.meetings(anyString(), any(), anyString(), anyString()))
                .thenReturn(new SearchGroup<>(2, List.of(
                        new MeetingMatch("mtg_title", 0, true),
                        new MeetingMatch("mtg_body", 9, false))));
        // Deliberately returned the other way round: findAllById makes no
        // promise about order, and title matches have to stay on top.
        when(meetings.findAllById(any())).thenReturn(List.of(
                meeting("mtg_body", "Weekly sync"), meeting("mtg_title", "Stripe migration")));

        SearchResponse res = service.search(USER, query("stripe"));

        assertThat(res.meetings().hits()).extracting(SearchResponse.MeetingHit::id)
                .containsExactly("mtg_title", "mtg_body");
    }
}
