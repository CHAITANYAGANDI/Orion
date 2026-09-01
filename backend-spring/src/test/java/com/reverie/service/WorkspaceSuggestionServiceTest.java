package com.reverie.service;

import com.reverie.entity.Meeting;
import com.reverie.entity.WorkspaceSuggestion;
import com.reverie.repository.MeetingRepository;
import com.reverie.repository.WorkspaceSuggestionRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Caching the workspace chat's starter questions.
 *
 * <p>Every case here is about spending or not spending a model call, and the
 * two directions fail differently. Regenerating too eagerly puts a paid call
 * behind a page load and makes the chips shuffle under someone mid-task.
 * Regenerating too rarely leaves questions that name last week's meetings,
 * which reads as a system that has lost track of what the user is doing — and
 * a new upload is exactly when they look at this page.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class WorkspaceSuggestionServiceTest {

    private static final String USER = "usr_1";
    private static final Duration TTL = Duration.ofHours(6);

    @Mock private WorkspaceSuggestionRepository cache;
    @Mock private MeetingRepository meetings;
    @Mock private AiClient ai;

    private WorkspaceSuggestionService service;

    @BeforeEach
    void setUp() {
        service = new WorkspaceSuggestionService(cache, meetings, ai, TTL);
        when(cache.findById(USER)).thenReturn(Optional.empty());
        when(meetings.findFirstByUserIdOrderByCreatedAtDesc(USER)).thenReturn(Optional.empty());
        when(ai.workspaceSuggestions(USER)).thenReturn(List.of("A fresh question?"));
    }

    private static WorkspaceSuggestion cached(Instant generatedAt, String... prompts) {
        WorkspaceSuggestion row = new WorkspaceSuggestion();
        row.setUserId(USER);
        row.setPrompts(List.of(prompts));
        row.setGeneratedAt(generatedAt);
        return row;
    }

    private static Meeting meetingCreatedAt(Instant when) {
        Meeting m = new Meeting();
        m.setUserId(USER);
        m.setCreatedAt(when);
        return m;
    }

    // --- generating ---------------------------------------------------------- //
    @Test
    @DisplayName("an empty cache generates and stores")
    void coldStartGenerates() {
        assertThat(service.forUser(USER)).containsExactly("A fresh question?");

        ArgumentCaptor<WorkspaceSuggestion> saved = ArgumentCaptor.forClass(WorkspaceSuggestion.class);
        verify(cache).save(saved.capture());
        assertThat(saved.getValue().getUserId()).isEqualTo(USER);
        assertThat(saved.getValue().getGeneratedAt()).isNotNull();
    }

    @Test
    @DisplayName("a fresh entry is served without calling the model")
    void freshEntryIsServedFromCache() {
        when(cache.findById(USER))
                .thenReturn(Optional.of(cached(Instant.now().minus(1, ChronoUnit.HOURS), "Cached?")));

        assertThat(service.forUser(USER)).containsExactly("Cached?");
        // The whole point of the cache: opening the page repeatedly in a
        // working session must be free.
        verify(ai, never()).workspaceSuggestions(anyString());
        verify(cache, never()).save(any());
    }

    // --- expiring ------------------------------------------------------------ //
    @Test
    @DisplayName("an aged entry regenerates")
    void agedEntryRegenerates() {
        when(cache.findById(USER))
                .thenReturn(Optional.of(cached(Instant.now().minus(7, ChronoUnit.HOURS), "Old?")));

        // Without an age limit a user with a stable archive sees the same three
        // questions for ever, which is the hard-coded list with extra steps.
        assertThat(service.forUser(USER)).containsExactly("A fresh question?");
        verify(cache).save(any());
    }

    @Test
    @DisplayName("a meeting that arrived after the suggestions regenerates them")
    void newerMeetingRegenerates() {
        Instant generated = Instant.now().minus(1, ChronoUnit.HOURS);
        when(cache.findById(USER)).thenReturn(Optional.of(cached(generated, "Old?")));
        when(meetings.findFirstByUserIdOrderByCreatedAtDesc(USER))
                .thenReturn(Optional.of(meetingCreatedAt(generated.plusSeconds(60))));

        // Still inside the TTL, so age alone would have served the stale set —
        // and it would name an archive the user has just added to.
        assertThat(service.forUser(USER)).containsExactly("A fresh question?");
    }

    @Test
    @DisplayName("a meeting older than the suggestions does not regenerate them")
    void olderMeetingKeepsCache() {
        Instant generated = Instant.now().minus(1, ChronoUnit.HOURS);
        when(cache.findById(USER)).thenReturn(Optional.of(cached(generated, "Cached?")));
        when(meetings.findFirstByUserIdOrderByCreatedAtDesc(USER))
                .thenReturn(Optional.of(meetingCreatedAt(generated.minusSeconds(60))));

        assertThat(service.forUser(USER)).containsExactly("Cached?");
        verify(ai, never()).workspaceSuggestions(anyString());
    }

    // --- degrading ----------------------------------------------------------- //
    @Test
    @DisplayName("an ai-service outage serves the stale entry rather than failing")
    void outageServesStale() {
        when(cache.findById(USER))
                .thenReturn(Optional.of(cached(Instant.now().minus(7, ChronoUnit.HOURS), "Stale?")));
        when(ai.workspaceSuggestions(USER)).thenThrow(new RuntimeException("ai-service down"));

        // A worse question is not a broken page. The chips are a convenience on
        // a chat that works without them.
        assertThat(service.forUser(USER)).containsExactly("Stale?");
        verify(cache, never()).save(any());
    }

    @Test
    @DisplayName("an outage with nothing cached returns empty rather than throwing")
    void outageWithNoCacheReturnsEmpty() {
        when(ai.workspaceSuggestions(USER)).thenThrow(new RuntimeException("ai-service down"));

        // Empty is what the UI renders as its own static prompts.
        assertThat(service.forUser(USER)).isEmpty();
    }

    @Test
    @DisplayName("an empty generation is not cached")
    void emptyGenerationIsNotCached() {
        when(ai.workspaceSuggestions(USER)).thenReturn(List.of());

        assertThat(service.forUser(USER)).isEmpty();
        // Caching "nothing" would keep the chips blank for six hours after the
        // user's first meeting finishes processing.
        verify(cache, never()).save(any());
    }

    @Test
    @DisplayName("an empty generation leaves an existing entry alone")
    void emptyGenerationKeepsPreviousPrompts() {
        when(cache.findById(USER))
                .thenReturn(Optional.of(cached(Instant.now().minus(7, ChronoUnit.HOURS), "Previous?")));
        when(ai.workspaceSuggestions(USER)).thenReturn(List.of());

        assertThat(service.forUser(USER)).containsExactly("Previous?");
        verify(cache, never()).save(any());
    }

    @Test
    @DisplayName("an entry with no timestamp is treated as expired")
    void missingTimestampRegenerates() {
        when(cache.findById(USER)).thenReturn(Optional.of(cached(null, "Undated?")));

        assertThat(service.forUser(USER)).containsExactly("A fresh question?");
    }
}
