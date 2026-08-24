package com.recallix.service;

import com.recallix.domain.MeetingStatus;
import com.recallix.dto.callback.AiActionItem;
import com.recallix.dto.callback.AiSegment;
import com.recallix.dto.callback.MeetingBriefResult;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingActionItem;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingInsightRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingSummaryRepository;
import com.recallix.repository.MeetingTranscriptRepository;
import com.recallix.repository.TranscriptSegmentRepository;
import com.recallix.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.context.ApplicationEventPublisher;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

/**
 * What a reprocess does to the action items.
 *
 * <p>Reprocessing is how you pick up a corrected transcript, and it used to
 * delete every action item for the meeting and write the extractor's output
 * again. That was harmless while the rows were read-only and became data loss
 * the moment they could be ticked off — the button that fixes a transcript would
 * also un-complete a week of work and delete everything anybody added by hand.
 *
 * <p>The tests come in pairs: what must survive, and what must not be duplicated
 * in the course of saving it.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ReprocessActionItemsTest {

    private static final String MEETING = "mtg_1";
    private static final LocalDate MEETING_DAY = LocalDate.of(2026, 8, 12);

    @Mock private MeetingRepository meetings;
    @Mock private MeetingTranscriptRepository transcripts;
    @Mock private TranscriptSegmentRepository segments;
    @Mock private MeetingSummaryRepository summaries;
    @Mock private MeetingActionItemRepository actionItems;
    @Mock private MeetingInsightRepository insights;
    @Mock private StatusPublisher statusPublisher;
    @Mock private UsageLimitService usage;
    @Mock private ApplicationEventPublisher events;
    @Mock private NotificationService notifications;
    @Mock private UserRepository users;

    private CallbackService service;

    /** Everything currently on the meeting; the fakes read and write this. */
    private final List<MeetingActionItem> stored = new ArrayList<>();

    @BeforeEach
    void setUp() {
        service = new CallbackService(meetings, transcripts, segments, summaries, actionItems,
                insights, statusPublisher, usage, events, notifications, users);
        stored.clear();

        Meeting meeting = new Meeting();
        meeting.setId(MEETING);
        meeting.setUserId("usr_1");
        meeting.setStatus(MeetingStatus.EXTRACTING);
        meeting.setCreatedAt(MEETING_DAY.atStartOfDay(ZoneOffset.UTC).toInstant());
        when(meetings.findById(MEETING)).thenReturn(Optional.of(meeting));

        when(actionItems.save(any())).thenAnswer(inv -> {
            stored.add(inv.getArgument(0));
            return inv.getArgument(0);
        });
        when(actionItems.findEditedByMeetingId(anyString()))
                .thenAnswer(inv -> stored.stream().filter(MeetingActionItem::isEdited).toList());
        // The real query deletes only the unedited rows; the fake has to as well
        // or every test here passes for the wrong reason.
        org.mockito.Mockito.doAnswer(inv -> {
            stored.removeIf(a -> !a.isEdited());
            return null;
        }).when(actionItems).deleteDerivedByMeetingId(anyString());
    }

    private static AiActionItem extracted(String title, String due, String sentence) {
        return new AiActionItem(title, "Priya", due, sentence);
    }

    private static final List<AiSegment> SEGMENTS = List.of(
            new AiSegment(0.0, 8.0, "Priya", "Right, shall we start?", null, null),
            new AiSegment(31.4, 44.0, "Priya",
                    "I will finish the JWT validation by Friday and then we can ship.", null, null));

    private static final List<AiActionItem> EXTRACTION = List.of(
            extracted("Finish the JWT validation", "friday", "I will finish the JWT validation by Friday"),
            extracted("Book the room", null, "Someone should book the room."));

    /** Run the worker callback with the standard extraction. */
    private void process() {
        service.applyResult(MEETING, new MeetingBriefResult(
                MEETING, "full text", "en", SEGMENTS, "short", "detailed",
                List.of(), List.of(), List.of(), "general", EXTRACTION, List.of(), List.of(), null, null));
    }

    /** Stand in for a person having worked the row. */
    private MeetingActionItem worked(String title) {
        MeetingActionItem item = stored.stream()
                .filter(a -> a.getTitle().equals(title)).findFirst().orElseThrow();
        item.setEdited(true);
        return item;
    }

    @Test
    @DisplayName("a completed item is still completed afterwards")
    void keepsCompletions() {
        process();
        MeetingActionItem done = worked("Finish the JWT validation");
        done.setStatus("DONE");
        done.setCompletedAt(Instant.now());

        process();

        assertThat(stored).filteredOn(a -> a.getId().equals(done.getId()))
                .singleElement()
                .satisfies(a -> assertThat(a.getStatus()).isEqualTo("DONE"));
    }

    @Test
    @DisplayName("a completed item does not come back a second time as open")
    void doesNotDuplicateWhatItKept() {
        process();
        worked("Finish the JWT validation").setStatus("DONE");

        process();

        // The whole point of keeping it is undone if the extractor's copy lands
        // beside it — the tracker would grow a duplicate on every reprocess.
        assertThat(stored).filteredOn(a -> a.getTitle().equals("Finish the JWT validation")).hasSize(1);
    }

    @Test
    @DisplayName("a corrected title survives, and the original does not return beside it")
    void keepsCorrectionsWithoutReintroducingTheOriginal() {
        process();
        MeetingActionItem renamed = worked("Finish the JWT validation");
        renamed.setTitle("Finish JWT validation in the gateway");

        process();

        // Matching on the title alone would fail exactly here: the row no longer
        // looks like what the extractor produces, so its own wording would come
        // back as a second task.
        assertThat(stored).extracting(MeetingActionItem::getTitle)
                .containsExactlyInAnyOrder("Finish JWT validation in the gateway", "Book the room");
    }

    @Test
    @DisplayName("an item added by hand survives, having no counterpart at all")
    void keepsHandAddedItems() {
        process();
        MeetingActionItem byHand = new MeetingActionItem();
        byHand.setId("ai_hand");
        byHand.setMeetingId(MEETING);
        byHand.setTitle("Chase legal");
        byHand.setEdited(true);
        stored.add(byHand);

        process();

        assertThat(stored).extracting(MeetingActionItem::getTitle).contains("Chase legal");
    }

    @Test
    @DisplayName("an untouched item is replaced rather than doubled")
    void sweepsWhatNobodyOwns() {
        process();
        process();

        assertThat(stored).filteredOn(a -> a.getTitle().equals("Book the room")).hasSize(1);
    }

    @Test
    @DisplayName("two promises made in one sentence stay two, even after one is edited")
    void doesNotLetOneSurvivorSuppressTwoItems() {
        String sentence = "I'll write the migration and Marcus will review it.";
        List<AiActionItem> pair = List.of(
                extracted("Write the migration", null, sentence),
                extracted("Review the migration", null, sentence));

        service.applyResult(MEETING, new MeetingBriefResult(
                MEETING, "t", "en", List.of(), "s", "d", List.of(), List.of(), List.of(),
                "general", pair, List.of(), List.of(), null, null));
        worked("Write the migration").setStatus("DONE");

        service.applyResult(MEETING, new MeetingBriefResult(
                MEETING, "t", "en", List.of(), "s", "d", List.of(), List.of(), List.of(),
                "general", pair, List.of(), List.of(), null, null));

        // A survivor claims one incoming item, not every item quoting the same
        // line — otherwise ticking off half a sentence deletes the other half.
        assertThat(stored).extracting(MeetingActionItem::getTitle)
                .containsExactlyInAnyOrder("Write the migration", "Review the migration");
    }

    @Test
    @DisplayName("a spoken deadline is resolved against the meeting, and an unreadable one is not invented")
    void resolvesDeadlinesOnTheWayIn() {
        process();

        assertThat(stored).filteredOn(a -> a.getTitle().equals("Finish the JWT validation"))
                .singleElement()
                .satisfies(a -> {
                    assertThat(a.getDueDate()).isEqualTo("friday");
                    assertThat(a.getDueOn()).isEqualTo(LocalDate.of(2026, 8, 14));
                });
        assertThat(stored).filteredOn(a -> a.getTitle().equals("Book the room"))
                .singleElement()
                .satisfies(a -> assertThat(a.getDueOn()).isNull());
    }

    @Test
    @DisplayName("the sentence is placed in the recording where it can be found")
    void locatesTheSourceSentence() {
        process();

        assertThat(stored).filteredOn(a -> a.getTitle().equals("Finish the JWT validation"))
                .singleElement()
                .satisfies(a -> assertThat(a.getSourceStartSeconds()).isEqualTo(31.4));
        // Nothing in the transcript says this, so no timestamp is offered.
        assertThat(stored).filteredOn(a -> a.getTitle().equals("Book the room"))
                .singleElement()
                .satisfies(a -> assertThat(a.getSourceStartSeconds()).isNull());
    }
}
