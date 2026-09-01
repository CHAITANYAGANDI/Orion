package com.reverie.service;

import com.reverie.common.ApiException;
import com.reverie.domain.SummarySection;
import com.reverie.domain.TranslatedLine;
import com.reverie.domain.TranslatedTask;
import com.reverie.dto.TranslationResponse;
import com.reverie.entity.Meeting;
import com.reverie.entity.MeetingActionItem;
import com.reverie.entity.MeetingSummary;
import com.reverie.entity.MeetingTranslation;
import com.reverie.entity.TranscriptSegment;
import com.reverie.repository.MeetingActionItemRepository;
import com.reverie.repository.MeetingRepository;
import com.reverie.repository.MeetingSummaryRepository;
import com.reverie.repository.MeetingTranslationRepository;
import com.reverie.repository.TranscriptSegmentRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Reading a meeting in another language.
 *
 * <p>The old implementation translated three flat fields and dropped the
 * structured sections, so switching language silently showed the reader less of
 * the meeting than staying in English did. Most of these tests exist to keep
 * that from coming back: everything a brief contains has to survive the round
 * trip, in its original shape, with the parts that identify a section rather
 * than describe it left alone.
 *
 * <p>The rest are about not lying. A translation of a sentence that has since
 * been rewritten is worse than English, because nothing on screen says it is out
 * of date — so a task whose wording has moved on is shown as it is now.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class TranslationServiceTest {

    private static final String USER = "usr_1";
    private static final String OTHER = "usr_2";
    private static final String MEETING = "mtg_1";

    @Mock private MeetingRepository meetings;
    @Mock private MeetingSummaryRepository summaries;
    @Mock private MeetingActionItemRepository actionItems;
    @Mock private TranscriptSegmentRepository segments;
    @Mock private MeetingTranslationRepository translations;
    @Mock private AiClient ai;
    @Mock private UsageLimitService usage;

    private TranslationService service;
    private final List<MeetingTranslation> stored = new ArrayList<>();
    private MeetingSummary summary;
    private final List<MeetingActionItem> tasks = new ArrayList<>();

    @BeforeEach
    void setUp() {
        service = new TranslationService(meetings, summaries, actionItems, segments, translations, ai, usage);
        stored.clear();
        tasks.clear();

        Meeting meeting = new Meeting();
        meeting.setId(MEETING);
        meeting.setUserId(USER);
        when(meetings.findByIdAndUserId(anyString(), anyString())).thenAnswer(inv ->
                MEETING.equals(inv.getArgument(0)) && USER.equals(inv.getArgument(1))
                        ? Optional.of(meeting) : Optional.empty());

        summary = new MeetingSummary();
        summary.setMeetingId(MEETING);
        summary.setShortSummary("We agreed to move billing to Stripe.");
        summary.setDetailedSummary("First paragraph.\n\nSecond paragraph.");
        summary.setKeyPoints(List.of("Stripe by Q4", "Marcus drafts the plan"));
        summary.setSections(List.of(
                new SummarySection("decisions", "Decisions", "bullets", "",
                        List.of("Move billing to Stripe"), List.of()),
                new SummarySection("outline", "Walkthrough", "outline", "",
                        List.of(),
                        List.of(new SummarySection.OutlineGroup("Billing",
                                List.of("Stripe won on fees"), 42.0)))));
        when(summaries.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING))
                .thenReturn(Optional.of(summary));

        tasks.add(task("ai_1", "Draft the rollout plan", "Marcus", "friday"));
        when(actionItems.findByMeetingId(MEETING)).thenAnswer(inv -> List.copyOf(tasks));

        when(segments.findByMeetingIdOrderByStartTimeAsc(MEETING)).thenReturn(List.of(
                segment("seg_1", "Priya", "Shall we start?"),
                segment("seg_2", "Marcus", "I'll draft the rollout plan.")));

        when(translations.save(any())).thenAnswer(inv -> {
            stored.add(inv.getArgument(0));
            return inv.getArgument(0);
        });
        when(translations.findByMeetingIdAndLanguage(anyString(), anyString())).thenAnswer(inv ->
                stored.stream()
                        .filter(t -> t.getMeetingId().equals(inv.getArgument(0))
                                && t.getLanguage().equals(inv.getArgument(1)))
                        .findFirst());
        when(translations.findByMeetingIdOrderByLanguageAsc(anyString())).thenAnswer(inv ->
                stored.stream().filter(t -> t.getMeetingId().equals(inv.getArgument(0))).toList());

        // A translator that marks every line, so the tests can see exactly what
        // was sent to it and what came back — including what was not sent.
        when(ai.translateLines(any(), anyString())).thenAnswer(inv -> {
            List<String> lines = inv.getArgument(0);
            // Null-safe because re-stubbing this in a nested test calls the mock
            // once with null arguments, and the previous answer runs on it.
            return lines == null ? List.of()
                    : lines.stream().map(l -> l.isEmpty() ? l : "ES " + l).toList();
        });
    }

    private static MeetingActionItem task(String id, String title, String owner, String due) {
        MeetingActionItem a = new MeetingActionItem();
        a.setId(id);
        a.setMeetingId(MEETING);
        a.setTitle(title);
        a.setOwnerName(owner);
        a.setDueDate(due);
        a.setStatus("OPEN");
        return a;
    }

    private static TranscriptSegment segment(String id, String speaker, String text) {
        TranscriptSegment s = new TranscriptSegment();
        s.setId(id);
        s.setMeetingId(MEETING);
        s.setSpeaker(speaker);
        s.setText(text);
        return s;
    }

    private TranslationResponse translateToSpanish() {
        return service.translate(USER, MEETING, "Spanish", false);
    }

    @Nested
    class ChoosingALanguage {

        @Test
        @DisplayName("a language we cannot work in is refused, with the list in the message")
        void refusesUnsupported() {
            // Not passed through to the model: "Klingon" would come back as
            // something, and a translation nobody asked for is indistinguishable
            // from a bug at the point somebody reads it.
            assertThatThrownBy(() -> service.translate(USER, MEETING, "Telugu", false))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("Spanish");
            verify(ai, never()).translateLines(any(), anyString());
        }

        @Test
        @DisplayName("a code, a name or an endonym all reach the same translation")
        void acceptsEverySpelling() {
            service.translate(USER, MEETING, "es", false);
            service.translate(USER, MEETING, "Spanish", false);
            service.translate(USER, MEETING, "Español", false);

            // One row, stored under the bare code — otherwise the same language
            // would be translated three times and shown three ways.
            assertThat(stored).singleElement()
                    .satisfies(t -> assertThat(t.getLanguage()).isEqualTo("es"));
        }

        @Test
        @DisplayName("another user's meeting is not found")
        void refusesSomebodyElsesMeeting() {
            assertThatThrownBy(() -> service.translate(OTHER, MEETING, "Spanish", false))
                    .isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("a meeting with no summary yet has nothing to translate")
        void needsASummary() {
            when(summaries.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING))
                    .thenReturn(Optional.empty());

            assertThatThrownBy(() -> translateToSpanish()).isInstanceOf(ApiException.class);
        }
    }

    @Nested
    class TheBrief {

        @Test
        @DisplayName("the whole summary comes back, not only its flat fields")
        void translatesEverything() {
            TranslationResponse out = translateToSpanish();

            assertThat(out.shortSummary()).isEqualTo("ES We agreed to move billing to Stripe.");
            assertThat(out.keyPoints()).containsExactly("ES Stripe by Q4", "ES Marcus drafts the plan");
            // The sections are where a templated brief keeps almost everything.
            // Dropping them was the old behaviour and it showed the reader less
            // of the meeting than English did.
            assertThat(out.sections()).hasSize(2);
            assertThat(out.sections().get(0).title()).isEqualTo("ES Decisions");
            assertThat(out.sections().get(0).bullets()).containsExactly("ES Move billing to Stripe");
        }

        @Test
        @DisplayName("an outline keeps its headings and the bullets under them")
        void translatesNestedStructure() {
            SummarySection outline = translateToSpanish().sections().get(1);

            assertThat(outline.groups()).singleElement().satisfies(g -> {
                assertThat(g.heading()).isEqualTo("ES Billing");
                assertThat(g.bullets()).containsExactly("ES Stripe won on fees");
            });
        }

        @Test
        @DisplayName("the identifiers a section is drawn by are left alone")
        void doesNotTranslateTheMachinery() {
            // `key` and `kind` are switched on by the renderer. Translated, every
            // section would come back as an unknown shape and render as nothing.
            assertThat(translateToSpanish().sections())
                    .extracting(SummarySection::key, SummarySection::kind)
                    .containsExactly(
                            org.assertj.core.groups.Tuple.tuple("decisions", "bullets"),
                            org.assertj.core.groups.Tuple.tuple("outline", "outline"));
        }

        @Test
        @DisplayName("a paragraph break survives the round trip")
        void keepsProseShape() {
            // Prose shares one batched call with the bullets, so it is split on
            // its newlines going in. Rejoining it wrongly would run two
            // paragraphs into one.
            assertThat(translateToSpanish().detailedSummary())
                    .isEqualTo("ES First paragraph.\n\nES Second paragraph.");
        }

        @Test
        @DisplayName("the brief is translated in one call, not one per field")
        void batchesTheWholeBrief() {
            translateToSpanish();

            verify(ai, times(1)).translateLines(any(), anyString());
        }

        @Test
        @DisplayName("the model is told the language by name, not by code")
        void namesTheLanguage() {
            // "Translate into es" is a worse instruction than "into Spanish".
            translateToSpanish();

            verify(ai).translateLines(any(), org.mockito.ArgumentMatchers.eq("Spanish"));
        }
    }

    @Nested
    class ActionItems {

        @Test
        @DisplayName("a task's wording and its spoken deadline are translated")
        void translatesTasks() {
            TranslationResponse.TranslatedTaskResponse out = translateToSpanish().actionItems().get(0);

            assertThat(out.title()).isEqualTo("ES Draft the rollout plan");
            assertThat(out.dueDate()).isEqualTo("ES friday");
            assertThat(out.translated()).isTrue();
        }

        @Test
        @DisplayName("a person's name is not translated")
        void leavesNamesAlone() {
            // Marcus is Marcus in every language.
            assertThat(translateToSpanish().actionItems().get(0).ownerName()).isEqualTo("Marcus");
        }

        @Test
        @DisplayName("a task retitled since is shown as it is now, and says so")
        void fallsBackWhenTheSourceMoved() {
            translateToSpanish();
            tasks.get(0).setTitle("Draft the rollout plan for Q4");

            TranslationResponse.TranslatedTaskResponse out =
                    service.translate(USER, MEETING, "Spanish", false).actionItems().get(0);

            // Showing the old translation would be showing a translation of a
            // sentence nobody can find any more.
            assertThat(out.title()).isEqualTo("Draft the rollout plan for Q4");
            assertThat(out.translated()).isFalse();
        }

        @Test
        @DisplayName("a task added since appears, untranslated rather than missing")
        void includesTasksAddedLater() {
            translateToSpanish();
            tasks.add(task("ai_2", "Chase legal", "Priya", null));

            List<TranslationResponse.TranslatedTaskResponse> out =
                    service.translate(USER, MEETING, "Spanish", false).actionItems();

            assertThat(out).hasSize(2);
            assertThat(out.get(1).title()).isEqualTo("Chase legal");
            assertThat(out.get(1).translated()).isFalse();
        }
    }

    @Nested
    class TheTranscript {

        @Test
        @DisplayName("it is not translated unless it was asked for")
        void isOptional() {
            TranslationResponse out = translateToSpanish();

            // An hour of speech costs real money and real seconds; spending both
            // for a reader who only opened the summary is spending them badly.
            assertThat(out.hasTranscript()).isFalse();
            assertThat(out.segments()).isEmpty();
            verify(segments, never()).findByMeetingIdOrderByStartTimeAsc(anyString());
        }

        @Test
        @DisplayName("asked for, every utterance keeps its own identity")
        void keepsSegmentIdentity() {
            TranslationResponse out = service.translate(USER, MEETING, "Spanish", true);

            // Keyed by segment id rather than by position: the speaker and the
            // timings are read from the live segment at render time, so a rename
            // takes effect in every language without rewriting a translation.
            assertThat(out.segments()).extracting(TranslationResponse.TranslatedSegmentResponse::id)
                    .containsExactly("seg_1", "seg_2");
            assertThat(out.segments().get(1).text()).isEqualTo("ES I'll draft the rollout plan.");
            assertThat(out.hasTranscript()).isTrue();
        }

        @Test
        @DisplayName("a meeting with no transcript says so rather than storing nothing")
        void needsATranscript() {
            when(segments.findByMeetingIdOrderByStartTimeAsc(MEETING)).thenReturn(List.of());

            assertThatThrownBy(() -> service.translate(USER, MEETING, "Spanish", true))
                    .isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("the transcript can be added to a brief already translated")
        void canBeAddedAfterwards() {
            translateToSpanish();

            TranslationResponse out = service.translate(USER, MEETING, "Spanish", true);

            assertThat(out.hasBrief()).isTrue();
            assertThat(out.hasTranscript()).isTrue();
        }
    }

    @Nested
    class NotDoingTheWorkTwice {

        @Test
        @DisplayName("asking again for a language already translated costs nothing")
        void isIdempotent() {
            translateToSpanish();
            translateToSpanish();

            // Safe to call on every language switch, which is what lets the
            // client stop tracking what exists.
            verify(ai, times(1)).translateLines(any(), anyString());
        }

        @Test
        @DisplayName("a stale translation is redone")
        void refreshesWhenTheMeetingMoved() {
            translateToSpanish();
            stored.get(0).setStale(true);

            translateToSpanish();

            verify(ai, times(2)).translateLines(any(), anyString());
            assertThat(stored.get(0).isStale()).isFalse();
        }

        @Test
        @DisplayName("refreshing the brief drops a transcript translation it can no longer vouch for")
        void doesNotLeaveHalfOfItStale() {
            service.translate(USER, MEETING, "Spanish", true);
            stored.get(0).setStale(true);

            TranslationResponse out = service.translate(USER, MEETING, "Spanish", false);

            // Keeping the old transcript while clearing the flag would leave the
            // page claiming to be current about words that have changed.
            assertThat(out.hasTranscript()).isFalse();
            assertThat(out.segments()).isEmpty();
            assertThat(out.stale()).isFalse();
        }

        @Test
        @DisplayName("a stale refresh that asks for the transcript redoes both")
        void refreshesBothWhenAsked() {
            service.translate(USER, MEETING, "Spanish", true);
            stored.get(0).setStale(true);

            TranslationResponse out = service.translate(USER, MEETING, "Spanish", true);

            assertThat(out.hasTranscript()).isTrue();
            assertThat(out.stale()).isFalse();
        }
    }

    @Nested
    class ReadingBack {

        @Test
        @DisplayName("a language never translated is not found")
        void unknownLanguageIsNotFound() {
            assertThatThrownBy(() -> service.get(USER, MEETING, "Spanish"))
                    .isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("the available list says what exists and how complete it is")
        void listsWhatExists() {
            service.translate(USER, MEETING, "Spanish", true);
            service.translate(USER, MEETING, "Japanese", false);

            assertThat(service.available(USER, MEETING))
                    .extracting(TranslationResponse.Available::language,
                            TranslationResponse.Available::hasTranscript)
                    .containsExactlyInAnyOrder(
                            org.assertj.core.groups.Tuple.tuple("es", true),
                            org.assertj.core.groups.Tuple.tuple("ja", false));
        }

        @Test
        @DisplayName("the response carries the reading direction")
        void carriesDirection() {
            // Arabic rendered left-to-right is not merely ugly, it is hard to
            // read, and the pane has to set `dir` from something.
            assertThat(service.translate(USER, MEETING, "Arabic", false).rightToLeft()).isTrue();
            assertThat(translateToSpanish().rightToLeft()).isFalse();
        }

        @Test
        @DisplayName("a translation can be thrown away")
        void deletes() {
            translateToSpanish();

            service.delete(USER, MEETING, "Spanish");

            verify(translations).delete(any(MeetingTranslation.class));
        }
    }

    @Nested
    class WhenTheModelFails {

        @Test
        @DisplayName("the brief is shown untranslated rather than blank")
        void degradesToTheOriginal() {
            // AiClient returns the source it was given when it cannot align a
            // reply. Untranslated text is a state a reader understands; empty
            // text is one they report as a bug.
            when(ai.translateLines(any(), anyString()))
                    .thenAnswer(inv -> List.copyOf(inv.getArgument(0)));

            TranslationResponse out = translateToSpanish();

            assertThat(out.shortSummary()).isEqualTo("We agreed to move billing to Stripe.");
            assertThat(out.sections()).hasSize(2);
        }

        @Test
        @DisplayName("a reply of the wrong length is discarded whole")
        void refusesToMisalign() {
            // One line short shifts every field of the brief by one, which reads
            // as nonsense rather than as a failure.
            when(ai.translateLines(any(), anyString()))
                    .thenAnswer(inv -> List.of("ES only one line"));

            TranslationResponse out = translateToSpanish();

            assertThat(out.shortSummary()).isEqualTo("We agreed to move billing to Stripe.");
            assertThat(out.keyPoints()).containsExactly("Stripe by Q4", "Marcus drafts the plan");
        }
    }

    @Test
    @DisplayName("what is stored is the translation, not a copy of the meeting")
    void storesOnlyWhatItTranslated() {
        service.translate(USER, MEETING, "Spanish", true);
        MeetingTranslation row = stored.get(0);

        assertThat(row.getSegments()).extracting(TranslatedLine::id)
                .containsExactly("seg_1", "seg_2");
        // The source wording is kept beside each task so a later edit can be
        // detected; nothing else about the task is duplicated.
        assertThat(row.getActionItems()).singleElement()
                .satisfies(t -> assertThat(t.sourceTitle()).isEqualTo("Draft the rollout plan"));
        assertThat(row.getActionItems()).extracting(TranslatedTask::id).containsExactly("ai_1");
    }
}
