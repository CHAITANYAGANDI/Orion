package com.orion.service;

import com.orion.common.ApiException;
import com.orion.dto.ActionItemBulkRequest;
import com.orion.dto.ActionItemCommentRequest;
import com.orion.dto.ActionItemCreateRequest;
import com.orion.dto.ActionItemPatchRequest;
import com.orion.dto.ActionItemQuery;
import com.orion.dto.ActionItemResponse;
import com.orion.domain.DueStatus;
import com.orion.entity.ActionItemComment;
import com.orion.entity.Meeting;
import com.orion.entity.MeetingActionItem;
import com.orion.entity.UserEntity;
import com.orion.repository.ActionItemCommentRepository;
import com.orion.repository.MeetingActionItemRepository;
import com.orion.repository.MeetingRepository;
import com.orion.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.data.domain.PageImpl;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Working an action item rather than reading one.
 *
 * <p>Most of these guard the same thing from different directions: that state a
 * person created survives. A tick, a retitle, a comment and a hand-added item
 * are all things the extractor did not produce and cannot reproduce, and the one
 * button in the product that regenerates a meeting used to delete every one of
 * them. That is why almost every write here sets {@code edited}, and why several
 * tests do nothing but assert it.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ActionItemServiceTest {

    private static final String USER = "usr_1";
    private static final String OTHER = "usr_2";
    private static final String MEETING = "mtg_1";
    private static final String ITEM = "ai_1";

    /** The meeting happened on a Wednesday; every relative deadline hangs off it. */
    private static final LocalDate MEETING_DAY = LocalDate.of(2026, 8, 12);

    @Mock private MeetingActionItemRepository actionItems;
    @Mock private ActionItemCommentRepository comments;
    @Mock private MeetingRepository meetings;
    @Mock private UserRepository users;
    @Mock private ApplicationEventPublisher events;

    private ActionItemService service;
    private final List<MeetingActionItem> stored = new ArrayList<>();
    private final List<ActionItemComment> log = new ArrayList<>();
    private UserEntity user;

    @BeforeEach
    void setUp() {
        service = new ActionItemService(actionItems, comments, meetings, users);
        stored.clear();
        log.clear();

        Meeting meeting = new Meeting();
        meeting.setId(MEETING);
        meeting.setUserId(USER);
        meeting.setTitle("Sprint planning");
        meeting.setCreatedAt(MEETING_DAY.atStartOfDay(ZoneOffset.UTC).toInstant());

        when(meetings.findByIdAndUserId(anyString(), anyString())).thenAnswer(inv ->
                MEETING.equals(inv.getArgument(0)) && USER.equals(inv.getArgument(1))
                        ? Optional.of(meeting) : Optional.empty());
        when(meetings.findById(MEETING)).thenReturn(Optional.of(meeting));
        when(meetings.findAllById(any())).thenReturn(List.of(meeting));

        stored.add(item(ITEM, "Finish the JWT validation", "OPEN"));

        when(actionItems.save(any())).thenAnswer(inv -> {
            stored.add(inv.getArgument(0));
            return inv.getArgument(0);
        });
        when(actionItems.findByIdForUser(anyString(), anyString())).thenAnswer(inv ->
                USER.equals(inv.getArgument(1))
                        ? stored.stream().filter(a -> a.getId().equals(inv.getArgument(0))).findFirst()
                        : Optional.empty());
        when(actionItems.findAllByIdForUser(any(), anyString())).thenAnswer(inv -> {
            if (!USER.equals(inv.getArgument(1))) {
                return List.of();
            }
            Collection<String> ids = inv.getArgument(0);
            return stored.stream().filter(a -> ids.contains(a.getId())).toList();
        });
        when(actionItems.findByMeetingId(MEETING)).thenAnswer(inv -> List.copyOf(stored));
        when(actionItems.findForUser(anyString(), any(), any(), anyBoolean(), any(), any(), any(), any(), any()))
                .thenAnswer(inv -> new PageImpl<>(List.copyOf(stored)));
        // Explicitly typed: List.of with one array argument spreads it, and the
        // varargs call infers List<Object> rather than List<Object[]>.
        when(actionItems.counts(anyString(), any(), any(), any()))
                .thenReturn(List.<Object[]>of(new Object[]{3L, 1L, 2L, 0L, 4L}));
        when(actionItems.owners(anyString()))
                .thenReturn(List.<Object[]>of(new Object[]{"Priya", 4L}, new Object[]{"Marcus", 1L}));

        when(comments.save(any())).thenAnswer(inv -> {
            log.add(inv.getArgument(0));
            return inv.getArgument(0);
        });
        when(comments.countByActionItemIds(any())).thenReturn(List.of());
        when(comments.countByActionItemId(anyString())).thenAnswer(inv ->
                log.stream().filter(c -> c.getActionItemId().equals(inv.getArgument(0))).count());
        when(comments.findByActionItemIdOrderByCreatedAtAsc(anyString())).thenAnswer(inv ->
                log.stream().filter(c -> c.getActionItemId().equals(inv.getArgument(0))).toList());
        when(comments.findByIdAndUserId(anyString(), anyString())).thenAnswer(inv ->
                log.stream()
                        .filter(c -> c.getId().equals(inv.getArgument(0))
                                && c.getUserId().equals(inv.getArgument(1)))
                        .findFirst());

        user = new UserEntity();
        user.setId(USER);
        when(users.findById(USER)).thenReturn(Optional.of(user));
    }

    private static MeetingActionItem item(String id, String title, String status) {
        MeetingActionItem a = new MeetingActionItem();
        a.setId(id);
        a.setMeetingId(MEETING);
        a.setTitle(title);
        a.setStatus(status);
        return a;
    }

    private static MeetingActionItem stored(List<MeetingActionItem> all, String id) {
        return all.stream().filter(a -> a.getId().equals(id)).findFirst().orElseThrow();
    }

    private static ActionItemCreateRequest creating(String title, String due) {
        return new ActionItemCreateRequest(title, "Priya", due, "Priya will do it.", 31.0);
    }

    @Nested
    class Creating {

        @Test
        @DisplayName("a hand-added item is protected from the next reprocess")
        void marksEdited() {
            service.create(USER, MEETING, creating("Send the pricing deck", null));

            // The extractor cannot reproduce something a person typed, so a
            // sweep that deleted it would delete it permanently.
            assertThat(stored.get(stored.size() - 1).isEdited()).isTrue();
        }

        @Test
        @DisplayName("the spoken deadline is read against the meeting's own date")
        void resolvesTheDeadline() {
            ActionItemResponse created = service.create(USER, MEETING, creating("Ship it", "friday"));

            assertThat(created.dueDate()).isEqualTo("friday");
            assertThat(created.dueOn()).isEqualTo(LocalDate.of(2026, 8, 14));
        }

        @Test
        @DisplayName("a deadline nobody can read is kept as words and left undated")
        void keepsUnreadableDeadlines() {
            ActionItemResponse created = service.create(USER, MEETING, creating("Ship it", "before the demo"));

            // Shown as said, absent from every deadline feature. Inventing a
            // date here is what produces overdue badges nobody earned.
            assertThat(created.dueDate()).isEqualTo("before the demo");
            assertThat(created.dueOn()).isNull();
            assertThat(created.dueStatus()).isEqualTo(DueStatus.NONE);
        }

        @Test
        @DisplayName("the moment it was said is carried through")
        void keepsTheTimestamp() {
            assertThat(service.create(USER, MEETING, creating("Ship it", null)).sourceStartSeconds())
                    .isEqualTo(31.0);
        }

        @Test
        @DisplayName("another user's meeting is not found")
        void refusesSomebodyElsesMeeting() {
            assertThatThrownBy(() -> service.create(OTHER, MEETING, creating("Mine now", null)))
                    .isInstanceOf(ApiException.class);
            verify(actionItems, never()).save(any());
        }

        @Test
        @DisplayName("an item knows who owns it, so it is findable without its meeting")
        void carriesTheOwner() {
            service.create(USER, MEETING, creating("Send the pricing deck", null));

            assertThat(stored.get(stored.size() - 1).getUserId()).isEqualTo(USER);
        }
    }

    /**
     * Tasks nobody said out loud.
     *
     * <p>The workspace panel's write. Same table and same list as a commitment
     * lifted from a transcript, because "what did I promise" is one question —
     * and a separate personal to-do list would be a second answer to it.
     */
    @Nested
    class TypedByHand {

        @Test
        @DisplayName("is created with no meeting at all")
        void hasNoMeeting() {
            ActionItemResponse created = service.createStandalone(
                    USER, new ActionItemCreateRequest("Write the migration", null, null, null, null));

            assertThat(created.meetingId()).isNull();
            assertThat(created.meetingTitle()).isNull();
            assertThat(stored.get(stored.size() - 1).isStandalone()).isTrue();
        }

        @Test
        @DisplayName("belongs to whoever typed it")
        void belongsToTheTyper() {
            service.createStandalone(
                    USER, new ActionItemCreateRequest("Write the migration", null, null, null, null));

            assertThat(stored.get(stored.size() - 1).getUserId()).isEqualTo(USER);
        }

        @Test
        @DisplayName("is protected from every reprocess, having no meeting to be swept by")
        void isEdited() {
            service.createStandalone(
                    USER, new ActionItemCreateRequest("Write the migration", null, null, null, null));

            assertThat(stored.get(stored.size() - 1).isEdited()).isTrue();
        }

        @Test
        @DisplayName("reads a deadline against today, since no meeting date could mean anything else")
        void resolvesAgainstToday() {
            ActionItemResponse created = service.createStandalone(
                    USER, new ActionItemCreateRequest("Ship it", null, "friday", null, null));

            assertThat(created.dueDate()).isEqualTo("friday");
            assertThat(created.dueOn()).isNotNull();
        }

    }

    @Nested
    class Editing {

        @Test
        @DisplayName("the title can be corrected")
        void retitles() {
            service.patch(USER, ITEM, new ActionItemPatchRequest("Finish JWT validation", null, null, null));

            assertThat(stored(stored, ITEM).getTitle()).isEqualTo("Finish JWT validation");
            assertThat(stored(stored, ITEM).isEdited()).isTrue();
        }

        @Test
        @DisplayName("a title cannot be emptied")
        void refusesAnEmptyTitle() {
            assertThatThrownBy(() -> service.patch(USER, ITEM,
                    new ActionItemPatchRequest("   ", null, null, null)))
                    .isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("a new deadline is re-read, so the date always matches the words")
        void rereadsTheDeadline() {
            service.patch(USER, ITEM, new ActionItemPatchRequest(null, null, "2026-09-01", null));

            assertThat(stored(stored, ITEM).getDueOn()).isEqualTo(LocalDate.of(2026, 9, 1));
        }

        @Test
        @DisplayName("an empty deadline clears both halves of it")
        void clearsTheDeadline() {
            service.patch(USER, ITEM, new ActionItemPatchRequest(null, null, "friday", null));
            service.patch(USER, ITEM, new ActionItemPatchRequest(null, null, "", null));

            // A stale dueOn under a cleared dueDate would keep an item overdue
            // for a deadline the page no longer shows.
            assertThat(stored(stored, ITEM).getDueDate()).isNull();
            assertThat(stored(stored, ITEM).getDueOn()).isNull();
        }

        @Test
        @DisplayName("an omitted field is left alone")
        void leavesOmittedFieldsAlone() {
            service.patch(USER, ITEM, new ActionItemPatchRequest(null, "Marcus", null, null));

            assertThat(stored(stored, ITEM).getTitle()).isEqualTo("Finish the JWT validation");
            assertThat(stored(stored, ITEM).getOwnerName()).isEqualTo("Marcus");
        }

        @Test
        @DisplayName("another user's item is not found")
        void refusesSomebodyElsesItem() {
            assertThatThrownBy(() -> service.patch(OTHER, ITEM,
                    new ActionItemPatchRequest("Mine now", null, null, null)))
                    .isInstanceOf(ApiException.class);
        }
    }

    @Nested
    class Completing {

        @Test
        @DisplayName("finishing something records when")
        void stampsCompletion() {
            service.patch(USER, ITEM, new ActionItemPatchRequest(null, null, null, "DONE"));

            assertThat(stored(stored, ITEM).getCompletedAt()).isNotNull();
        }

        @Test
        @DisplayName("reopening clears the stamp rather than leaving a lie")
        void clearsTheStampOnReopen() {
            service.patch(USER, ITEM, new ActionItemPatchRequest(null, null, null, "DONE"));
            service.patch(USER, ITEM, new ActionItemPatchRequest(null, null, null, "OPEN"));

            assertThat(stored(stored, ITEM).getCompletedAt()).isNull();
        }

        @Test
        @DisplayName("re-completing does not move the completion time")
        void doesNotRestampAnAlreadyDoneItem() {
            service.patch(USER, ITEM, new ActionItemPatchRequest(null, null, null, "DONE"));
            Instant first = stored(stored, ITEM).getCompletedAt();

            service.patch(USER, ITEM, new ActionItemPatchRequest(null, null, null, "DONE"));

            assertThat(stored(stored, ITEM).getCompletedAt()).isEqualTo(first);
        }

        @Test
        @DisplayName("a finished item is never overdue")
        void doneIsNotOverdue() {
            MeetingActionItem late = stored(stored, ITEM);
            late.setDueOn(LocalDate.of(2000, 1, 1));
            late.setStatus("DONE");

            assertThat(service.listForMeeting(USER, MEETING))
                    .filteredOn(a -> a.id().equals(ITEM))
                    .singleElement()
                    .satisfies(a -> {
                        assertThat(a.dueStatus()).isEqualTo(DueStatus.NONE);
                        assertThat(a.daysUntilDue()).isNegative();
                    });
        }

        @Test
        @DisplayName("an unknown status is refused")
        void validatesStatus() {
            assertThatThrownBy(() -> service.patch(USER, ITEM,
                    new ActionItemPatchRequest(null, null, null, "ALMOST")))
                    .isInstanceOf(ApiException.class);
        }
    }

    @Nested
    class Bulk {

        @BeforeEach
        void addMore() {
            stored.add(item("ai_2", "Draft the plan", "OPEN"));
            stored.add(item("ai_3", "Book the room", "DONE"));
        }

        @Test
        @DisplayName("one call completes several")
        void completesMany() {
            int changed = service.bulkStatus(USER, new ActionItemBulkRequest(List.of(ITEM, "ai_2"), "DONE"));

            assertThat(changed).isEqualTo(2);
            assertThat(stored(stored, ITEM).getStatus()).isEqualTo("DONE");
            assertThat(stored(stored, "ai_2").getCompletedAt()).isNotNull();
        }

        @Test
        @DisplayName("items already in that state are not counted as changed")
        void skipsNoOps() {
            // Otherwise "3 completed" appears after ticking one thing, and the
            // completion times of the other two move for no reason.
            Instant before = Instant.now().minusSeconds(60);
            stored(stored, "ai_3").setCompletedAt(before);

            int changed = service.bulkStatus(USER, new ActionItemBulkRequest(List.of(ITEM, "ai_3"), "DONE"));

            assertThat(changed).isEqualTo(1);
            assertThat(stored(stored, "ai_3").getCompletedAt()).isEqualTo(before);
        }

        @Test
        @DisplayName("ids the caller does not own change nothing")
        void ignoresUnownedIds() {
            assertThat(service.bulkStatus(OTHER, new ActionItemBulkRequest(List.of(ITEM), "DONE"))).isZero();
            assertThat(stored(stored, ITEM).getStatus()).isEqualTo("OPEN");
        }

        @Test
        @DisplayName("everything changed in bulk is protected from a reprocess too")
        void marksEdited() {
            service.bulkStatus(USER, new ActionItemBulkRequest(List.of(ITEM, "ai_2"), "DONE"));

            assertThat(stored(stored, ITEM).isEdited()).isTrue();
            assertThat(stored(stored, "ai_2").isEdited()).isTrue();
        }
    }

    /**
     * The home panel's list.
     *
     * <p>The panel beside the chat used to show every action item in the
     * workspace, which put one commitment in three places at once — on its
     * meeting, in that panel, and on a tracker page — with nothing to say which
     * of them ticking it off was supposed to happen in. It now asks for the
     * ones nobody's transcript produced, and a commitment is completed on the
     * meeting that produced it.
     *
     * <p>This is worth a test rather than trust because the failure is silent:
     * a filter that quietly does nothing gives back a list that looks like an
     * answer.
     */
    @Nested
    class StandaloneOnly {

        @Test
        @DisplayName("the filter reaches the query")
        void asksForStandalone() {
            service.list(USER, new ActionItemQuery(null, null, null, null, true, false, 0, 50));

            verify(actionItems).findForUser(anyString(), any(), any(),
                    org.mockito.ArgumentMatchers.eq(true), any(), any(), any(), any(), any());
        }

        @Test
        @DisplayName("and is off unless asked for, so a meeting's own list is untouched")
        void defaultsToEverything() {
            service.list(USER, ActionItemQuery.open());

            verify(actionItems).findForUser(anyString(), any(), any(),
                    org.mockito.ArgumentMatchers.eq(false), any(), any(), any(), any(), any());
        }
    }

    @Nested
    class MyTasks {

        @Test
        @DisplayName("asking for mine before saying who I am returns nothing")
        void refusesToGuess() {
            var page = service.list(USER, new ActionItemQuery(null, null, null, null, false, true, 0, 50));

            // The alternative is showing the whole workspace under the heading
            // "My tasks", which reads as an answer and is not one.
            assertThat(page.content()).isEmpty();
            verify(actionItems, never()).findForUser(anyString(), any(), any(), anyBoolean(),
                    any(), any(), any(), any(), any());
        }

        @Test
        @DisplayName("my name is matched however the transcript spells it")
        void matchesCaseInsensitively() {
            user.setDisplayName("  Priya  ");

            service.list(USER, new ActionItemQuery(null, null, null, null, false, true, 0, 50));

            verify(actionItems).findForUser(anyString(), any(), any(), anyBoolean(),
                    org.mockito.ArgumentMatchers.eq("priya"), any(), any(), any(), any());
        }

        @Test
        @DisplayName("the overview says who I am so the page can offer to fix it")
        void reportsTheName() {
            user.setDisplayName("Priya");

            assertThat(service.overview(USER).me()).isEqualTo("Priya");
        }

        @Test
        @DisplayName("the owner filter offers the names actually assigned work")
        void listsOwners() {
            assertThat(service.overview(USER).owners())
                    .extracting("name")
                    .containsExactly("Priya", "Marcus");
        }

        @Test
        @DisplayName("the tab counts come from one read")
        void countsAreBatched() {
            var counts = service.overview(USER).counts();

            assertThat(counts.open()).isEqualTo(3);
            assertThat(counts.overdue()).isEqualTo(1);
            assertThat(counts.dueSoon()).isEqualTo(2);
            assertThat(counts.done()).isEqualTo(4);
            verify(actionItems).counts(anyString(), any(), any(), any());
        }

        @Test
        @DisplayName("a brand-new workspace counts zero rather than failing")
        void survivesAnEmptyWorkspace() {
            when(actionItems.counts(anyString(), any(), any(), any())).thenReturn(List.of());

            assertThat(service.overview(USER).counts().open()).isZero();
        }
    }

    @Nested
    class Comments {

        @Test
        @DisplayName("a note can be logged against a task")
        void logs() {
            service.addComment(USER, ITEM, new ActionItemCommentRequest("  Waiting on legal.  "));

            assertThat(service.listComments(USER, ITEM))
                    .singleElement()
                    .satisfies(c -> assertThat(c.body()).isEqualTo("Waiting on legal."));
        }

        @Test
        @DisplayName("writing one protects the task it is written on")
        void marksTheItemEdited() {
            // The log cascades away with the item, so a reprocess that deleted
            // the item would take the log with it.
            service.addComment(USER, ITEM, new ActionItemCommentRequest("Waiting on legal."));

            assertThat(stored(stored, ITEM).isEdited()).isTrue();
        }

        @Test
        @DisplayName("another user's task cannot be commented on or read")
        void scopedToTheOwner() {
            assertThatThrownBy(() -> service.addComment(OTHER, ITEM,
                    new ActionItemCommentRequest("Hello"))).isInstanceOf(ApiException.class);
            assertThatThrownBy(() -> service.listComments(OTHER, ITEM))
                    .isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("a comment can only be deleted through the task it belongs to")
        void deleteIsScopedToItsItem() {
            var comment = service.addComment(USER, ITEM, new ActionItemCommentRequest("Waiting on legal."));

            assertThatThrownBy(() -> service.deleteComment(USER, "ai_other", comment.id()))
                    .isInstanceOf(ApiException.class);

            service.deleteComment(USER, ITEM, comment.id());
            verify(comments).delete(any());
        }
    }
}
