package com.reverie.service;

import com.reverie.common.ApiException;
import com.reverie.domain.MomentRange;
import com.reverie.dto.MomentRequest;
import com.reverie.dto.MomentResponse;
import com.reverie.entity.Meeting;
import com.reverie.entity.TranscriptMoment;
import com.reverie.repository.MeetingRepository;
import com.reverie.repository.TranscriptMomentRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.context.ApplicationEventPublisher;

import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Marking a passage of a transcript.
 *
 * <p>The interesting failures here are not "the wrong row came back" — they are
 * rows that save cleanly and then cannot be drawn. A highlight with no quote, a
 * range anchored to neither a segment nor any text, an end before its start:
 * each of those is accepted by a naive write path and then disappears silently
 * from the transcript, which reads to the user as an app that lost their work.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class MomentServiceTest {

    private static final String USER = "usr_1";
    private static final String OTHER = "usr_2";
    private static final String MEETING = "mtg_1";

    @Mock private TranscriptMomentRepository moments;
    @Mock private MeetingRepository meetings;
    @Mock private AuditService audit;
    @Mock private ApplicationEventPublisher events;

    private MomentService service;

    @BeforeEach
    void setUp() {
        service = new MomentService(moments, meetings, audit);
        Meeting m = new Meeting();
        m.setId(MEETING);
        m.setUserId(USER);
        when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(m));
        when(meetings.findByIdAndUserId(anyString(), anyString())).thenAnswer(inv ->
                MEETING.equals(inv.getArgument(0)) && USER.equals(inv.getArgument(1))
                        ? Optional.of(m)
                        : Optional.empty());
        when(moments.countByMeetingId(MEETING)).thenReturn(0L);
    }

    private static MomentRequest highlight(MomentRange... ranges) {
        return new MomentRequest("HIGHLIGHT", List.of(ranges), "the quoted words", "",
                "Priya", 12.0, 18.0);
    }

    private TranscriptMoment saved() {
        ArgumentCaptor<TranscriptMoment> c = ArgumentCaptor.forClass(TranscriptMoment.class);
        verify(moments).save(c.capture());
        return c.getValue();
    }

    private TranscriptMoment existing(String kind) {
        TranscriptMoment m = new TranscriptMoment();
        m.setId("mom_1");
        m.setMeetingId(MEETING);
        m.setUserId(USER);
        m.setKind(kind);
        m.setQuote("the quoted words");
        m.setBody("HIGHLIGHT".equals(kind) ? "" : "the original label");
        when(moments.findById("mom_1")).thenReturn(Optional.of(m));
        return m;
    }

    // --- creating ------------------------------------------------------------ //
    @Nested
    class Creating {

        @Test
        @DisplayName("a highlight keeps its anchor, its quote and its speaker")
        void storesTheAnchor() {
            service.add(USER, MEETING, highlight(new MomentRange("seg_1", 4, 20, "the quoted words")));

            TranscriptMoment m = saved();
            assertThat(m.getId()).startsWith("mom_");
            assertThat(m.getKind()).isEqualTo("HIGHLIGHT");
            assertThat(m.getQuote()).isEqualTo("the quoted words");
            // Denormalised on purpose: reprocessing rebuilds the segments, and
            // a moment that can only name its speaker by joining to one becomes
            // unreadable the first time somebody asks for a better transcript.
            assertThat(m.getSpeaker()).isEqualTo("Priya");
            assertThat(m.getRanges()).hasSize(1);
            assertThat(m.getRanges().get(0).segmentId()).isEqualTo("seg_1");
        }

        @Test
        @DisplayName("a selection crossing utterances keeps every range")
        void keepsEveryRange() {
            // Diarization splits on pauses rather than sentences, so one spoken
            // sentence routinely arrives as two segments. Dropping all but the
            // first would highlight half of what the user dragged over.
            service.add(USER, MEETING, highlight(
                    new MomentRange("seg_1", 30, 44, "we should ship"),
                    new MomentRange("seg_2", 0, 12, "on the ninth")));

            assertThat(saved().getRanges()).hasSize(2);
        }

        @Test
        @DisplayName("a range anchored to nothing is dropped")
        void dropsUnanchorableRanges() {
            // No segment and no text is a range that can never be resolved back
            // onto the transcript. Kept, it would be an invisible gap inside a
            // highlight that silently covers less than was selected.
            service.add(USER, MEETING, highlight(
                    new MomentRange("seg_1", 0, 5, "hello"),
                    new MomentRange("", 0, 0, "  ")));

            assertThat(saved().getRanges()).hasSize(1);
        }

        @Test
        @DisplayName("a negative offset is clamped rather than rejected")
        void clampsOffsets() {
            // It came from a client that measured badly; the quote will still
            // find the passage, so refusing the whole mark helps nobody.
            service.add(USER, MEETING, highlight(new MomentRange("seg_1", -3, 12, "hello")));

            assertThat(saved().getRanges().get(0).startOffset()).isZero();
        }

        @Test
        @DisplayName("an end before its start is pulled up to the start")
        void clampsTheTimeSpan() {
            // A backwards span sorts into the right place and then renders as a
            // zero-width mark, which looks like a highlight that was lost.
            service.add(USER, MEETING, new MomentRequest(
                    "HIGHLIGHT", List.of(), "words", "", "", 30.0, 10.0));

            assertThat(saved().getStartSeconds()).isEqualTo(30.0);
            assertThat(saved().getEndSeconds()).isEqualTo(30.0);
        }

        @Test
        @DisplayName("a bookmark needs no quote")
        void bookmarksMarkATimeNotAPassage() {
            service.add(USER, MEETING, new MomentRequest(
                    "BOOKMARK", List.of(), "", "Worth revisiting", "Priya", 90.0, 90.0));

            assertThat(saved().getKind()).isEqualTo("BOOKMARK");
            assertThat(saved().getQuote()).isEmpty();
        }

        @Test
        @DisplayName("a highlight with nothing selected is refused")
        void highlightNeedsAQuote() {
            // Nothing to draw and, worse, nothing to re-find it by after the
            // line is edited.
            assertThatThrownBy(() -> service.add(USER, MEETING, new MomentRequest(
                    "HIGHLIGHT", List.of(), "   ", "", "", 1.0, 2.0)))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("selected text");
            verify(moments, never()).save(any());
        }

        @Test
        @DisplayName("a note with an empty body is refused")
        void noteNeedsABody() {
            assertThatThrownBy(() -> service.add(USER, MEETING, new MomentRequest(
                    "NOTE", List.of(), "words", "  ", "", 1.0, 2.0)))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("written in it");
        }

        @Test
        @DisplayName("an unrecognised kind becomes a highlight")
        void unknownKindDefaults() {
            service.add(USER, MEETING, new MomentRequest(
                    "SCRIBBLE", List.of(), "words", "", "", 1.0, 2.0));

            assertThat(saved().getKind()).isEqualTo("HIGHLIGHT");
        }

        @Test
        @DisplayName("someone else's meeting is not found")
        void cannotMarkAnotherUsersMeeting() {
            assertThatThrownBy(() -> service.add(OTHER, MEETING, highlight()))
                    .isInstanceOf(ApiException.class);
            verify(moments, never()).save(any());
        }

        @Test
        @DisplayName("a reaction anchors to a time and carries its emoji")
        void reactionsMarkATimeWithAnEmoji() {
            service.add(USER, MEETING, new MomentRequest(
                    "REACTION", List.of(), "We should ship on Thursday", "\uD83D\uDD25",
                    "Priya", 90.0, 90.0));

            TranscriptMoment m = saved();
            assertThat(m.getKind()).isEqualTo("REACTION");
            assertThat(m.getBody()).isEqualTo("\uD83D\uDD25");
            // No ranges: it is about what somebody said, not about a span of
            // characters inside it. Ranges would paint the whole paragraph in
            // highlighter, which is the styling that means something else.
            assertThat(m.getRanges()).isEmpty();
            assertThat(m.getStartSeconds()).isEqualTo(90.0);
        }

        @Test
        @DisplayName("a reaction with no emoji is refused")
        void reactionNeedsAnEmoji() {
            assertThatThrownBy(() -> service.add(USER, MEETING, new MomentRequest(
                    "REACTION", List.of(), "words", "  ", "", 1.0, 1.0)))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("needs an emoji");
            verify(moments, never()).save(any());
        }

        @Test
        @DisplayName("a reaction long enough to be a sentence is refused")
        void reactionIsNotASecondNote() {
            assertThatThrownBy(() -> service.add(USER, MEETING, new MomentRequest(
                    "REACTION", List.of(), "words", "this is a whole opinion", "", 1.0, 1.0)))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("single emoji");
        }

        @Test
        @DisplayName("a multi-code-point emoji is still one emoji")
        void reactionCountsCodePointsNotChars() {
            // A thumbs-up is a surrogate pair and a skin-toned one is two more
            // code points again. Counting chars would reject the characters
            // this field exists for.
            service.add(USER, MEETING, new MomentRequest(
                    "REACTION", List.of(), "words", "\uD83D\uDC4D\uD83C\uDFFD", "", 1.0, 1.0));

            assertThat(saved().getKind()).isEqualTo("REACTION");
        }

        @Test
        @DisplayName("reacting twice with the same emoji is a no-op, not a duplicate")
        void reactingTwiceIsIdempotent() {
            TranscriptMoment already = new TranscriptMoment();
            already.setId("mom_9");
            already.setMeetingId(MEETING);
            already.setUserId(USER);
            already.setKind("REACTION");
            already.setBody("\uD83D\uDC4D");
            already.setStartSeconds(90.0);
            when(moments.findFirstByMeetingIdAndUserIdAndKindAndStartSecondsAndBody(
                    MEETING, USER, "REACTION", 90.0, "\uD83D\uDC4D"))
                    .thenReturn(Optional.of(already));

            MomentResponse out = service.add(USER, MEETING, new MomentRequest(
                    "REACTION", List.of(), "words", "\uD83D\uDC4D", "Priya", 90.0, 90.0));

            // The UI toggles, so this only happens when two clicks race or two
            // tabs are open on one meeting. Either way the second row renders
            // exactly on top of the first, and the pair reads as two people.
            assertThat(out.id()).isEqualTo("mom_9");
            verify(moments, never()).save(any());
        }

        @Test
        @DisplayName("a different emoji on the same turn is a new reaction")
        void differentEmojiIsNotADuplicate() {
            service.add(USER, MEETING, new MomentRequest(
                    "REACTION", List.of(), "words", "\uD83D\uDD25", "Priya", 90.0, 90.0));

            assertThat(saved().getBody()).isEqualTo("\uD83D\uDD25");
        }

        @Test
        @DisplayName("a meeting already at the cap refuses more")
        void capsPerMeeting() {
            when(moments.countByMeetingId(MEETING)).thenReturn((long) MomentService.MAX_PER_MEETING);

            assertThatThrownBy(() -> service.add(USER, MEETING, highlight()))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("Delete some first");
        }
    }

    // --- editing and deleting ------------------------------------------------ //
    @Nested
    class Editing {

        @Test
        @DisplayName("editing changes the body and leaves the anchor alone")
        void editsOnlyTheBody() {
            existing("NOTE");

            MomentResponse out = service.updateBody(USER, "mom_1",
                    new MomentRequest("HIGHLIGHT", List.of(), "different", "revised note", "", 0.0, 0.0));

            assertThat(out.body()).isEqualTo("revised note");
            // Re-pointing a note at a different passage is a new note. Doing it
            // in place would leave a comment attached to words nobody wrote it
            // about — and the kind in the request is ignored for the same
            // reason it is on an insight.
            assertThat(out.kind()).isEqualTo("NOTE");
            assertThat(out.quote()).isEqualTo("the quoted words");
        }

        @Test
        @DisplayName("emptying a note's body is refused")
        void cannotEmptyANote() {
            existing("NOTE");

            assertThatThrownBy(() -> service.updateBody(USER, "mom_1",
                    new MomentRequest(null, List.of(), "", "   ", "", 0.0, 0.0)))
                    .isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("emptying a reaction is refused")
        void cannotEmptyAReaction() {
            existing("REACTION");

            // A reaction *is* its body. Swapping one emoji for another is fine;
            // leaving the mark with nothing to draw is not.
            assertThatThrownBy(() -> service.updateBody(USER, "mom_1",
                    new MomentRequest(null, List.of(), "", "   ", "", 0.0, 0.0)))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("needs an emoji");
        }

        @Test
        @DisplayName("clearing a bookmark's label is allowed")
        void aBookmarkMayLoseItsLabel() {
            existing("BOOKMARK");

            // The label was optional to begin with; the mark is the timestamp.
            assertThat(service.updateBody(USER, "mom_1",
                    new MomentRequest(null, List.of(), "", "", "", 0.0, 0.0)).body()).isEmpty();
        }

        @Test
        @DisplayName("another user's moment is not found, not forbidden")
        void cannotTouchAnotherUsersMoment() {
            existing("HIGHLIGHT");

            // Same message either way, so a 404 never confirms the row exists.
            assertThatThrownBy(() -> service.delete(OTHER, "mom_1"))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("Not found");
            assertThatThrownBy(() -> service.updateBody(OTHER, "mom_1",
                    new MomentRequest(null, List.of(), "", "x", "", 0.0, 0.0)))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("Not found");
            verify(moments, never()).delete(any());
        }

        @Test
        @DisplayName("deleting removes the row")
        void deletes() {
            TranscriptMoment m = existing("HIGHLIGHT");

            service.delete(USER, "mom_1");

            verify(moments).delete(m);
        }
    }

    // --- listing -------------------------------------------------------------- //
    @Test
    @DisplayName("listing is scoped to the owner")
    void listingRequiresOwnership() {
        assertThatThrownBy(() -> service.list(OTHER, MEETING)).isInstanceOf(ApiException.class);
        verify(moments, never()).findByMeetingIdOrderByStartSecondsAscCreatedAtAsc(anyString());
    }

    @Test
    @DisplayName("listing returns the meeting's moments in transcript order")
    void listsInTranscriptOrder() {
        TranscriptMoment m = new TranscriptMoment();
        m.setId("mom_1");
        m.setMeetingId(MEETING);
        m.setUserId(USER);
        m.setKind("HIGHLIGHT");
        m.setQuote("words");
        when(moments.findByMeetingIdOrderByStartSecondsAscCreatedAtAsc(MEETING))
                .thenReturn(List.of(m));

        assertThat(service.list(USER, MEETING)).extracting(MomentResponse::id).containsExactly("mom_1");
    }
}
