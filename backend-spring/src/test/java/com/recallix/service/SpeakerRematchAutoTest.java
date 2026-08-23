package com.recallix.service;

import com.recallix.common.SpeakerLabels;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingTranscript;
import com.recallix.entity.TranscriptSegment;
import com.recallix.entity.UserEntity;
import com.recallix.repository.MeetingInsightRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingSummaryRepository;
import com.recallix.repository.MeetingTranscriptRepository;
import com.recallix.repository.MeetingTranslationRepository;
import com.recallix.repository.ProjectRepository;
import com.recallix.repository.SpeakerProfileRepository;
import com.recallix.repository.TranscriptSegmentRepository;
import com.recallix.repository.UserRepository;
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
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * "Rematch speakers": one click, and everything it refuses to do.
 *
 * <p>The operation is small and the refusals are the feature. Renaming
 * <em>Speaker 2</em> to <em>Sarah</em> when it was not Sarah puts a real
 * person's name on words they never said, writes it into the retrieval index,
 * and gets it read back out of chat as a cited fact — the user has no way to
 * tell that apart from a true answer. Leaving <em>Speaker 2</em> alone is
 * visibly unfinished and invites the manual fix that has always existed.
 *
 * <p>So the matcher is allowed to be wrong in one direction only, and these
 * tests pin that direction down at the Spring end: what gets applied, what is
 * protected from being applied to, and what happens to everything downstream of
 * a name change.
 *
 * <p>The acoustic decision itself is not tested here — it is not made here. The
 * ai-service holds the model and returns proposals; see
 * {@code ai-service/tests/test_speaker_rematch.py} for the thresholds, the
 * ambiguity margin and the four refusals.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class SpeakerRematchAutoTest {

    private static final String USER = "usr_1";
    private static final String OTHER_USER = "usr_2";
    private static final String MEETING = "mtg_1";
    private static final String KEY = "meetings/usr_1/mtg_1/audio.webm";

    @Mock private MeetingRepository meetings;
    @Mock private MeetingTranscriptRepository transcripts;
    @Mock private TranscriptSegmentRepository segments;
    @Mock private MeetingSummaryRepository summaries;
    @Mock private MeetingInsightRepository insights;
    @Mock private StorageService storage;
    @Mock private UsageLimitService usage;
    @Mock private OutboxService outbox;
    @Mock private AuditService audit;
    @Mock private AiClient ai;
    @Mock private SummaryTemplateService templates;
    @Mock private ProjectRepository projects;
    @Mock private MeetingTranslationRepository translations;
    @Mock private NotificationService notifications;
    @Mock private ErasureService erasure;
    @Mock private UserService userService;
    @Mock private UserRepository users;
    @Mock private SpeakerProfileRepository profiles;

    private SpeakerIdentityService identity;
    private MeetingService service;
    private List<TranscriptSegment> segs;
    private MeetingTranscript transcript;
    private UserEntity user;

    @BeforeEach
    void setUp() {
        identity = new SpeakerIdentityService(users, profiles, ai, audit);
        service = new MeetingService(meetings, transcripts, segments, summaries, insights,
                storage, usage, outbox, audit, ai, templates, projects, translations,
                notifications, erasure, userService, identity);

        Meeting meeting = new Meeting();
        meeting.setId(MEETING);
        meeting.setUserId(USER);
        meeting.setObjectKey(KEY);

        user = new UserEntity();
        user.setId(USER);
        user.setSpeakerLearningEnabled(true);

        // Two people. spk_1 spoke first and twice; spk_2 spoke once, at length.
        segs = new ArrayList<>(List.of(
                seg("seg_1", "spk_1", "Speaker 1", 0.0, 20.0, "Shall we start?"),
                seg("seg_2", "spk_2", "Speaker 2", 20.0, 55.0, "Yes. The renewal is the thing."),
                seg("seg_3", "spk_1", "Speaker 1", 55.0, 70.0, "Agreed.")));

        transcript = new MeetingTranscript();
        transcript.setMeetingId(MEETING);
        transcript.setTranscriptText("Speaker 1: Shall we start?");

        when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(meeting));
        when(meetings.findByIdAndUserId(MEETING, OTHER_USER)).thenReturn(Optional.empty());
        when(segments.findByMeetingIdOrderByStartTimeAsc(MEETING)).thenReturn(segs);
        when(transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING))
                .thenReturn(Optional.of(transcript));
        when(summaries.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING)).thenReturn(Optional.empty());
        when(users.findById(USER)).thenReturn(Optional.of(user));
        when(users.findById(OTHER_USER)).thenReturn(Optional.empty());
    }

    private static TranscriptSegment seg(String id, String key, String speaker,
                                         double start, double end, String text) {
        TranscriptSegment s = new TranscriptSegment();
        s.setId(id);
        s.setMeetingId(MEETING);
        s.setSpeakerKey(key);
        s.setSpeaker(speaker);
        s.setStartTime(start);
        s.setEndTime(end);
        s.setText(text);
        s.setSpeakerStatus("attributed");
        return s;
    }

    /** The ai-service saying "spk_2 is confidently Sarah". */
    private void aiMatches(String speakerKey, String name) {
        when(ai.identifySpeakers(eq(USER), eq(MEETING), any(), anyList()))
                .thenReturn(new AiClient.SpeakerIdentification(
                        List.of(new AiClient.SpeakerMatch(speakerKey, name, "spf_1", 0.83)),
                        1, 1, null));
    }

    private void aiMatchesNobody(int considered) {
        when(ai.identifySpeakers(eq(USER), eq(MEETING), any(), anyList()))
                .thenReturn(new AiClient.SpeakerIdentification(List.of(), considered, 3, null));
    }

    // ================================================================== //
    @Nested
    @DisplayName("1. a confident match")
    class ConfidentMatch {

        @Test
        @DisplayName("renames every turn belonging to that canonical speaker")
        void everyTurnMoves() {
            segs.add(seg("seg_4", "spk_2", "Speaker 2", 70.0, 95.0, "I'll draft it."));
            aiMatches("spk_2", "Sarah");

            var result = service.rematchSpeakers(USER, MEETING);

            assertThat(result.matched()).isEqualTo(1);
            assertThat(result.names()).containsExactly("Sarah");
            // Both of spk_2's turns, not just the one the matcher happened to
            // measure. The key is the unit of identity; the label is a display.
            assertThat(segs.stream().filter(s -> "spk_2".equals(s.getSpeakerKey()))
                    .map(TranscriptSegment::getSpeaker)).containsOnly("Sarah");
        }

        @Test
        @DisplayName("leaves the other speaker's turns alone")
        void othersUntouched() {
            aiMatches("spk_2", "Sarah");

            service.rematchSpeakers(USER, MEETING);

            assertThat(segs.stream().filter(s -> "spk_1".equals(s.getSpeakerKey()))
                    .map(TranscriptSegment::getSpeaker)).containsOnly("Speaker 1");
        }

        @Test
        @DisplayName("keeps the canonical key stable, so colour and talk-time follow the person")
        void keysAreNotTouched() {
            aiMatches("spk_2", "Sarah");

            service.rematchSpeakers(USER, MEETING);

            // Renaming has to change exactly one of the two fields. If the key
            // moved, the speaker's colour would change and their talk-time row
            // would split in half.
            assertThat(segs).extracting(TranscriptSegment::getSpeakerKey)
                    .containsExactly("spk_1", "spk_2", "spk_1");
        }
    }

    // ================================================================== //
    @Nested
    @DisplayName("3 and 4. who is off limits")
    class OffLimits {

        @Test
        @DisplayName("a speaker somebody already named is never overwritten")
        void manualNameWins() {
            segs.get(1).setSpeaker("Sarah");
            // The matcher is told which labels are unresolved and would not
            // propose this one. Spring checks anyway: this is the line between
            // "a bad match" and "undid a user's work", and it is cheap to make
            // the second impossible on this side of the wire too.
            aiMatches("spk_2", "Tom");

            var result = service.rematchSpeakers(USER, MEETING);

            assertThat(segs.get(1).getSpeaker()).isEqualTo("Sarah");
            assertThat(result.matched()).isZero();
        }

        @Test
        @DisplayName("a name from an earlier rematch is treated exactly like a typed one")
        void anEarlierRematchIsAlsoProtected() {
            aiMatches("spk_2", "Sarah");
            service.rematchSpeakers(USER, MEETING);

            // A second pass, with the matcher now proposing somebody else.
            aiMatches("spk_2", "Tom");
            var second = service.rematchSpeakers(USER, MEETING);

            assertThat(segs.get(1).getSpeaker()).isEqualTo("Sarah");
            assertThat(second.matched()).isZero();
        }

        @Test
        @DisplayName("an unattributed turn is not offered to the matcher at all")
        void unknownSpeakersAreNotSentForIdentification() {
            segs.get(1).setSpeakerStatus("unknown");
            segs.get(1).setSpeaker("Unknown speaker");
            aiMatchesNobody(1);

            service.rematchSpeakers(USER, MEETING);

            // The provider declined to say whose turn it was, so the audio under
            // it may be anybody's — or two people at once. There is no voice
            // there to identify, and sending it would invite a guess.
            var sent = org.mockito.ArgumentCaptor.forClass(List.class);
            verify(ai).identifySpeakers(eq(USER), eq(MEETING), any(), sent.capture());
            assertThat(sent.getValue()).extracting("speakerKey").containsExactly("spk_1");
        }

        @Test
        @DisplayName("a transcript written before canonical keys existed is left entirely alone")
        void preV46SegmentsAreSkipped() {
            segs.forEach(s -> s.setSpeakerKey(null));
            aiMatchesNobody(0);

            service.rematchSpeakers(USER, MEETING);

            var sent = org.mockito.ArgumentCaptor.forClass(List.class);
            verify(ai).identifySpeakers(eq(USER), eq(MEETING), any(), sent.capture());
            // Grouping those by display name instead would merge two people who
            // had both been renamed to the same thing into one voiceprint that
            // belongs to neither.
            assertThat(sent.getValue()).isEmpty();
        }
    }

    // ================================================================== //
    @Nested
    @DisplayName("7 and 8. what identity is not based on")
    class NeverGuesses {

        @Test
        @DisplayName("the speaker number is an address, never evidence")
        void noNumberEquality() {
            aiMatchesNobody(2);

            var result = service.rematchSpeakers(USER, MEETING);

            // Nothing is renamed when the acoustic matcher declines, even though
            // "spk_2 was Sarah in the last meeting" is sitting right there. The
            // numbers are assigned by who spoke first; the only thing spk_2 in
            // March shares with spk_2 in January is who cleared their throat.
            assertThat(segs).extracting(TranscriptSegment::getSpeaker)
                    .containsExactly("Speaker 1", "Speaker 2", "Speaker 1");
            assertThat(result.matched()).isZero();
        }

        @Test
        @DisplayName("no language model is asked whose voice it was")
        void noLlmInvolved() {
            aiMatches("spk_2", "Sarah");

            service.rematchSpeakers(USER, MEETING);

            // The only AI calls a rematch is allowed to make are the acoustic
            // identification and the re-index that follows it. Asking a model
            // that has never heard the audio who was speaking would get an
            // answer, and that is the problem: it would read "thanks, Sarah" in
            // the transcript and confidently identify the person being thanked.
            verify(ai, never()).chat(anyString(), anyString(), anyString(), any(), anyList());
            verify(ai, never()).summarize(anyString(), anyString(), any(), any());
        }

        @Test
        @DisplayName("the transcript text never reaches the identifier")
        void wordsAreNotSent() {
            aiMatchesNobody(2);

            service.rematchSpeakers(USER, MEETING);

            var sent = org.mockito.ArgumentCaptor.forClass(List.class);
            verify(ai).identifySpeakers(eq(USER), eq(MEETING), any(), sent.capture());
            // Turn boundaries and a label, and nothing that was said. A matcher
            // with the words would eventually decide that whoever was called
            // "Sarah" out loud must be the voice that answered.
            @SuppressWarnings("unchecked")
            List<AiClient.SpeakerTurns> turns = sent.getValue();
            assertThat(turns).allSatisfy(t -> {
                assertThat(t.spans()).isNotEmpty();
                assertThat(t.displayName()).doesNotContain("renewal");
            });
        }
    }

    // ================================================================== //
    @Nested
    @DisplayName("9. everything downstream of a name")
    class Downstream {

        @Test
        @DisplayName("the meeting is re-indexed, so chat stops citing the old label")
        void reindexes() {
            aiMatches("spk_2", "Sarah");

            service.rematchSpeakers(USER, MEETING);

            var text = org.mockito.ArgumentCaptor.forClass(String.class);
            verify(ai).reindex(eq(USER), eq(MEETING), text.capture(), anyList());
            // Retrieval passages are stored as "Speaker 2: ..." — an un-indexed
            // rematch leaves chat answering with a name the transcript no longer
            // shows anywhere, and citing it.
            assertThat(text.getValue()).contains("Sarah: Yes. The renewal is the thing.");
            assertThat(text.getValue()).doesNotContain("Speaker 2");
        }

        @Test
        @DisplayName("the flat transcript is rewritten, because the export reads it")
        void rewritesTheFlatTranscript() {
            aiMatches("spk_2", "Sarah");

            service.rematchSpeakers(USER, MEETING);

            assertThat(transcript.getTranscriptText()).contains("Sarah:");
            assertThat(transcript.getTranscriptText()).doesNotContain("Speaker 2");
        }

        @Test
        @DisplayName("nothing is re-indexed when nobody was matched")
        void noWorkWhenNothingChanged() {
            aiMatchesNobody(2);

            service.rematchSpeakers(USER, MEETING);

            verify(ai, never()).reindex(anyString(), anyString(), anyString(), anyList());
            assertThat(transcript.getTranscriptText()).isEqualTo("Speaker 1: Shall we start?");
        }
    }

    // ================================================================== //
    @Nested
    @DisplayName("12. what the toast is told")
    class Reporting {

        @Test
        @DisplayName("the count is speakers renamed, not turns rewritten")
        void countsSpeakers() {
            segs.add(seg("seg_4", "spk_2", "Speaker 2", 70.0, 95.0, "And again."));
            segs.add(seg("seg_5", "spk_2", "Speaker 2", 95.0, 120.0, "And again."));
            aiMatches("spk_2", "Sarah");

            var result = service.rematchSpeakers(USER, MEETING);

            // Three turns moved. One person was identified. "3 speakers
            // rematched" would be a lie about a two-person meeting.
            assertThat(result.matched()).isEqualTo(1);
        }

        @Test
        @DisplayName("finding nobody is a result, not a failure")
        void nobodyIsAnAnswer() {
            aiMatchesNobody(2);

            var result = service.rematchSpeakers(USER, MEETING);

            assertThat(result.matched()).isZero();
            assertThat(result.considered()).isEqualTo(2);
            // Null, and that is the whole distinction: the user is owed
            // "nobody matched", not "matching is unavailable".
            assertThat(result.unavailable()).isNull();
        }

        @Test
        @DisplayName("being unable to look is reported differently from looking and finding nobody")
        void unavailableIsItsOwnOutcome() {
            when(ai.identifySpeakers(eq(USER), eq(MEETING), any(), anyList()))
                    .thenReturn(new AiClient.SpeakerIdentification(
                            List.of(), 0, 0, "Speaker matching is not installed on this server."));

            var result = service.rematchSpeakers(USER, MEETING);

            assertThat(result.unavailable()).contains("not installed");
        }

        @Test
        @DisplayName("an account that has not opted in is told so, and nothing is sent")
        void consentIsCheckedBeforeAnythingLeaves() {
            user.setSpeakerLearningEnabled(false);

            var result = service.rematchSpeakers(USER, MEETING);

            assertThat(result.unavailable()).contains("Settings");
            verify(ai, never()).identifySpeakers(anyString(), anyString(), any(), anyList());
        }
    }

    // ================================================================== //
    @Nested
    @DisplayName("6. a name typed by hand")
    class ManualRename {

        @Test
        @DisplayName("updates every turn of that canonical speaker, not just the matching labels")
        void renameAppliesByKey() {
            // The second turn was moved to spk_2 by a manual fix, so its label
            // and its identity disagree. Renaming "Speaker 2" has to follow the
            // person, which is the key, not the string on screen.
            segs.get(1).setSpeaker("Speaker 2");
            segs.add(seg("seg_4", "spk_2", "Speaker 9", 70.0, 95.0, "Also me."));

            service.renameSpeakers(USER, MEETING, Map.of("Speaker 2", "Sarah"));

            assertThat(segs.stream().filter(s -> "spk_2".equals(s.getSpeakerKey()))
                    .map(TranscriptSegment::getSpeaker)).containsOnly("Sarah");
        }

        @Test
        @DisplayName("learns the voice, because that is the moment a human vouched for it")
        void learnsOnRename() {
            service.renameSpeakers(USER, MEETING, Map.of("Speaker 2", "Sarah"));

            verify(ai).learnSpeaker(eq(USER), eq(MEETING), eq(KEY), eq("spk_2"),
                    eq("Sarah"), anyList());
        }

        @Test
        @DisplayName("learns nothing for an account that has not opted in")
        void noLearningWithoutConsent() {
            user.setSpeakerLearningEnabled(false);

            service.renameSpeakers(USER, MEETING, Map.of("Speaker 2", "Sarah"));

            assertThat(segs.get(1).getSpeaker()).isEqualTo("Sarah");
            verify(ai, never()).learnSpeaker(anyString(), anyString(), any(), anyString(),
                    anyString(), anyList());
        }

        @Test
        @DisplayName("renaming one placeholder to another is a merge, and teaches nothing")
        void placeholderToPlaceholderIsNotAnIdentification() {
            service.renameSpeakers(USER, MEETING, Map.of("Speaker 2", "Speaker 1"));

            verify(ai, never()).learnSpeaker(anyString(), anyString(), any(), anyString(),
                    anyString(), anyList());
        }
    }

    // ================================================================== //
    @Nested
    @DisplayName("11. the manual repair still exists")
    class FixDiarizationStillWorks {

        @Test
        @DisplayName("merging one label into another still folds every turn across")
        void mergeStillWorks() {
            var req = new com.recallix.dto.SpeakerRematchRequest("Speaker 2", "Speaker 1", null);

            service.fixDiarization(USER, MEETING, req);

            assertThat(segs).extracting(TranscriptSegment::getSpeaker)
                    .containsExactly("Speaker 1", "Speaker 1", "Speaker 1");
        }

        @Test
        @DisplayName("moving individual turns still works")
        void reassignStillWorks() {
            var req = new com.recallix.dto.SpeakerRematchRequest(null, "Speaker 1",
                    List.of("seg_2"));

            service.fixDiarization(USER, MEETING, req);

            assertThat(segs.get(1).getSpeaker()).isEqualTo("Speaker 1");
        }

        @Test
        @DisplayName("it is a different operation from Rematch and solves a different problem")
        void theTwoAreNotInterchangeable() {
            // Rematch cannot fix one person split across two labels: both are
            // unresolved, and the matcher would have to claim one profile twice
            // to merge them — which it refuses to do, correctly.
            aiMatchesNobody(2);
            assertThat(service.rematchSpeakers(USER, MEETING).matched()).isZero();

            service.fixDiarization(USER, MEETING,
                    new com.recallix.dto.SpeakerRematchRequest("Speaker 2", "Speaker 1", null));
            assertThat(segs).extracting(TranscriptSegment::getSpeaker).containsOnly("Speaker 1");
        }
    }

    // ================================================================== //
    @Nested
    @DisplayName("13. one account's voices")
    class TenantIsolation {

        @Test
        @DisplayName("another account cannot rematch this meeting")
        void notYourMeeting() {
            assertThat(org.assertj.core.api.Assertions.catchThrowable(
                    () -> service.rematchSpeakers(OTHER_USER, MEETING)))
                    .isInstanceOf(com.recallix.common.ApiException.class);
            verify(ai, never()).identifySpeakers(anyString(), anyString(), any(), anyList());
        }

        @Test
        @DisplayName("the owner is sent with every identification, because RLS checks it")
        void theOwnerTravels() {
            aiMatchesNobody(2);

            service.rematchSpeakers(USER, MEETING);

            // The ai-service has no privilege to look an owner up — its
            // connection is confined to the tenant stamped on it, with no
            // bypass. Sending the wrong one reads nothing rather than reading
            // somebody else's voices.
            verify(ai).identifySpeakers(eq(USER), eq(MEETING), eq(KEY), anyList());
        }
    }

    // ================================================================== //
    @Nested
    @DisplayName("the placeholder rule itself")
    class WhatCountsAsUnresolved {

        @Test
        @DisplayName("matches what Recallix generates and nothing else")
        void narrowOnPurpose() {
            assertThat(SpeakerLabels.isUnresolved("Speaker 1")).isTrue();
            assertThat(SpeakerLabels.isUnresolved("Speaker 12")).isTrue();
            assertThat(SpeakerLabels.isUnresolved("spk_2")).isTrue();
            assertThat(SpeakerLabels.isUnresolved("Unknown speaker")).isTrue();

            assertThat(SpeakerLabels.isUnresolved("Sarah")).isFalse();
            assertThat(SpeakerLabels.isUnresolved("Interviewer 2")).isFalse();
            assertThat(SpeakerLabels.isUnresolved("Facilitator")).isFalse();
            // The one a prefix test gets wrong, and a name somebody could
            // plausibly type.
            assertThat(SpeakerLabels.isUnresolved("Speaker of the House")).isFalse();
        }

        @Test
        @DisplayName("an unattributed turn is not a placeholder")
        void blankIsNotUnresolved() {
            assertThat(SpeakerLabels.isUnresolved(null)).isFalse();
            assertThat(SpeakerLabels.isUnresolved("  ")).isFalse();
        }
    }
}
