package com.reverie.service;

import com.reverie.common.ApiException;
import com.reverie.common.DueDates;
import com.reverie.common.IdGenerator;
import com.reverie.dto.ActionItemBulkRequest;
import com.reverie.dto.ActionItemCommentRequest;
import com.reverie.dto.ActionItemCommentResponse;
import com.reverie.dto.ActionItemCreateRequest;
import com.reverie.dto.ActionItemOverview;
import com.reverie.dto.ActionItemPatchRequest;
import com.reverie.dto.ActionItemQuery;
import com.reverie.dto.ActionItemResponse;
import com.reverie.dto.PageResponse;
import com.reverie.domain.DueStatus;
import com.reverie.entity.ActionItemComment;
import com.reverie.entity.Meeting;
import com.reverie.entity.MeetingActionItem;
import com.reverie.entity.UserEntity;
import com.reverie.repository.ActionItemCommentRepository;
import com.reverie.repository.MeetingActionItemRepository;
import com.reverie.repository.MeetingRepository;
import com.reverie.repository.UserRepository;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Action-item queries and updates, always scoped to the owning user.
 *
 * <p>Two rules run through everything here. The first is that any change a
 * person makes marks the row {@code edited}, which is what stops a reprocess
 * from undoing it — see {@link com.reverie.entity.MeetingActionItem}. The
 * second is that a written deadline is re-read whenever it changes, so
 * {@code dueOn} can never describe a {@code dueDate} that has since been
 * replaced.
 */
@Service
public class ActionItemService {

    private static final Set<String> VALID_STATUSES = Set.of("OPEN", "IN_PROGRESS", "DONE");
    private static final String DONE = "DONE";

    private final MeetingActionItemRepository actionItems;
    private final ActionItemCommentRepository comments;
    private final MeetingRepository meetings;
    private final UserRepository users;

    public ActionItemService(MeetingActionItemRepository actionItems,
                             ActionItemCommentRepository comments,
                             MeetingRepository meetings,
                             UserRepository users) {
        this.actionItems = actionItems;
        this.comments = comments;
        this.meetings = meetings;
        this.users = users;
    }

    /**
     * Today, in UTC.
     *
     * <p>Reverie stores no timezone per user, so a deadline is a day in one
     * fixed frame or it is nothing. UTC is the only defensible choice and the
     * error it can cause is bounded: a task is briefly called overdue up to a
     * day early or late depending on how far from Greenwich you are. Picking the
     * server's zone instead would make the same error and change it on
     * redeployment.
     */
    private static LocalDate today() {
        return LocalDate.now(ZoneOffset.UTC);
    }

    @Transactional(readOnly = true)
    public List<ActionItemResponse> listForMeeting(String userId, String meetingId) {
        Meeting meeting = meetings.findByIdAndUserId(meetingId, userId)
                .orElseThrow(() -> ApiException.notFound("Meeting not found"));
        List<MeetingActionItem> items = actionItems.findByMeetingId(meetingId);
        Map<String, Integer> counts = commentCounts(items);
        LocalDate today = today();
        return items.stream()
                .map(a -> ActionItemResponse.from(a, meeting.getTitle(), today,
                        counts.getOrDefault(a.getId(), 0)))
                .toList();
    }

    /** The meeting's name, or null for a task nobody said out loud. */
    private static String titleOf(MeetingActionItem item, Map<String, String> titles) {
        return item.getMeetingId() == null ? null : titles.get(item.getMeetingId());
    }

    @Transactional(readOnly = true)
    public PageResponse<ActionItemResponse> list(String userId, ActionItemQuery q) {
        LocalDate today = today();
        String owner = q.mine() ? myName(userId) : q.owner();
        if (q.mine() && owner == null) {
            // They asked for their own work before saying who they are. An empty
            // page is the truthful answer — every item would otherwise be
            // "unassigned" and the list would look like somebody else's.
            return PageResponse.from(
                    Page.<MeetingActionItem>empty(PageRequest.of(q.page(), q.size())), List.of());
        }

        Page<MeetingActionItem> result = actionItems.findForUser(
                userId, q.status(), q.meetingId(), q.standalone(), owner, q.due(),
                today, today.plusDays(DueStatus.SOON_DAYS),
                PageRequest.of(q.page(), q.size()));

        Map<String, String> titles = titlesFor(result.getContent());
        Map<String, Integer> counts = commentCounts(result.getContent());
        List<ActionItemResponse> content = result.getContent().stream()
                .map(a -> ActionItemResponse.from(a, titleOf(a, titles), today,
                        counts.getOrDefault(a.getId(), 0)))
                .toList();
        return PageResponse.from(result, content);
    }

    /** The tab counts, the owner filter and who "me" is — one read for the whole page. */
    @Transactional(readOnly = true)
    public ActionItemOverview overview(String userId) {
        LocalDate today = today();
        String me = myName(userId);

        Object[] row = actionItems.counts(userId, me, today, today.plusDays(DueStatus.SOON_DAYS))
                .stream().findFirst().orElse(new Object[]{0L, 0L, 0L, 0L, 0L});

        List<ActionItemOverview.OwnerCount> owners = actionItems.owners(userId).stream()
                .map(o -> new ActionItemOverview.OwnerCount((String) o[0], count(o[1])))
                .toList();

        return new ActionItemOverview(
                new ActionItemOverview.Counts(
                        count(row[0]), count(row[1]), count(row[2]), count(row[3]), count(row[4])),
                owners,
                displayNameOf(userId));
    }

    /**
     * Record a commitment somebody spotted while reading.
     *
     * <p>Stored in the same table as the extracted ones rather than a parallel
     * "manual" list, because the question the action-items page answers is "what
     * did we promise" — and an answer split across two lists by how each row was
     * noticed is two answers.
     */
    @Transactional
    public ActionItemResponse create(String userId, String meetingId, ActionItemCreateRequest req) {
        Meeting meeting = meetings.findByIdAndUserId(meetingId, userId)
                .orElseThrow(() -> ApiException.notFound("Meeting not found"));

        MeetingActionItem item = new MeetingActionItem();
        item.setId(IdGenerator.actionItem());
        item.setUserId(userId);
        item.setMeetingId(meetingId);
        item.setTitle(req.title().trim());
        item.setOwnerName(blankToNull(req.ownerName()));
        item.setStatus("OPEN");
        item.setSourceSentence(blankToNull(req.sourceSentence()));
        item.setSourceStartSeconds(req.sourceStartSeconds());
        // Typed by a person, so nothing the extractor produces may replace it.
        item.setEdited(true);
        setDue(item, blankToNull(req.dueDate()), meeting);
        actionItems.save(item);

        return ActionItemResponse.from(item, meeting.getTitle(), today(), 0);
    }

    /**
     * Record something somebody typed rather than said.
     *
     * <p>The workspace panel's one write. No meeting, because there is no
     * conversation this came out of — see V36 for why attaching it to the most
     * recent one would be worse than leaving it unattached.
     *
     * <p>Everything else is the same row in the same table, so a typed task is
     * counted, filtered, reminded about, exported and deleted exactly like a
     * spoken one. A parallel "personal to-do" list would be a second answer to
     * the question this page exists to answer once.
     */
    @Transactional
    public ActionItemResponse createStandalone(String userId, ActionItemCreateRequest req) {
        MeetingActionItem item = new MeetingActionItem();
        item.setId(IdGenerator.actionItem());
        item.setUserId(userId);
        item.setMeetingId(null);
        item.setTitle(req.title().trim());
        item.setOwnerName(blankToNull(req.ownerName()));
        item.setStatus("OPEN");
        // Typed by a person, so a reprocess must never sweep it away.
        item.setEdited(true);
        // Resolved against today rather than a meeting's date: "Friday" typed
        // this morning means this Friday, and there is no conversation whose
        // date could mean anything else.
        setDue(item, blankToNull(req.dueDate()), null);
        actionItems.save(item);

        return ActionItemResponse.from(item, null, today(), 0);
    }

    @Transactional
    public ActionItemResponse patch(String userId, String id, ActionItemPatchRequest req) {
        MeetingActionItem item = actionItems.findByIdForUser(id, userId)
                .orElseThrow(() -> ApiException.notFound("Action item not found"));
        // Null for one typed on the home screen, and for one whose meeting has
        // since been deleted. Both are ordinary, so every use below tolerates it.
        Meeting meeting = item.getMeetingId() == null
                ? null
                : meetings.findById(item.getMeetingId()).orElse(null);

        if (req.title() != null) {
            String title = req.title().trim();
            if (title.isEmpty()) {
                throw ApiException.badRequest("An action item needs a title");
            }
            item.setTitle(title);
        }
        if (req.ownerName() != null) {
            item.setOwnerName(blankToNull(req.ownerName()));
        }
        if (req.dueDate() != null) {
            // Blank clears it; anything else is re-read, so dueOn always
            // describes the text sitting next to it.
            setDue(item, blankToNull(req.dueDate()), meeting);
        }
        if (req.status() != null) {
            applyStatus(item, req.status());
        }
        item.setEdited(true);

        return ActionItemResponse.from(item,
                meeting == null ? null : meeting.getTitle(),
                today(),
                (int) comments.countByActionItemId(item.getId()));
    }

    /**
     * Apply one status to many items.
     *
     * @return how many rows actually changed — ids the caller does not own, and
     *         items already in that status, are skipped rather than counted.
     */
    @Transactional
    public int bulkStatus(String userId, ActionItemBulkRequest req) {
        String status = requireStatus(req.status());
        List<MeetingActionItem> owned = actionItems.findAllByIdForUser(req.ids(), userId);

        int changed = 0;
        for (MeetingActionItem item : owned) {
            if (status.equals(item.getStatus())) {
                continue;
            }
            applyStatus(item, status);
            item.setEdited(true);
            changed++;
        }
        return changed;
    }

    /**
     * Remove an action item.
     *
     * <p>Deleted rather than hidden: these are mostly extracted, so a wrong one
     * is the model's mistake and there is nothing to preserve. Its comments go
     * with it by cascade.
     */
    @Transactional
    public void delete(String userId, String id) {
        MeetingActionItem item = actionItems.findByIdForUser(id, userId)
                .orElseThrow(() -> ApiException.notFound("Action item not found"));
        actionItems.delete(item);
    }

    /* ------------------------------ comments ------------------------------ */

    @Transactional(readOnly = true)
    public List<ActionItemCommentResponse> listComments(String userId, String actionItemId) {
        requireItem(userId, actionItemId);
        return comments.findByActionItemIdOrderByCreatedAtAsc(actionItemId).stream()
                .map(ActionItemCommentResponse::from)
                .toList();
    }

    @Transactional
    public ActionItemCommentResponse addComment(String userId, String actionItemId,
                                                ActionItemCommentRequest req) {
        MeetingActionItem item = requireItem(userId, actionItemId);

        ActionItemComment comment = new ActionItemComment();
        comment.setId(IdGenerator.comment());
        comment.setActionItemId(actionItemId);
        comment.setUserId(userId);
        comment.setBody(req.body().trim());
        comments.save(comment);

        // The log lives on the item and dies with it, so writing one has to be
        // enough to protect the item from the next reprocess.
        item.setEdited(true);

        return ActionItemCommentResponse.from(comment);
    }

    @Transactional
    public void deleteComment(String userId, String actionItemId, String commentId) {
        ActionItemComment comment = comments.findByIdAndUserId(commentId, userId)
                .filter(c -> c.getActionItemId().equals(actionItemId))
                .orElseThrow(() -> ApiException.notFound("Comment not found"));
        comments.delete(comment);
    }

    /* ------------------------------- helpers ------------------------------ */

    private MeetingActionItem requireItem(String userId, String actionItemId) {
        return actionItems.findByIdForUser(actionItemId, userId)
                .orElseThrow(() -> ApiException.notFound("Action item not found"));
    }

    /**
     * Set the written deadline and our reading of it together.
     *
     * <p>Resolved against the meeting's own date, not today's: "Tuesday" meant
     * the Tuesday after the meeting, and a phrase re-read months later would
     * quietly move the deadline every time somebody opened the page.
     */
    private void setDue(MeetingActionItem item, String spoken, Meeting meeting) {
        item.setDueDate(spoken);
        item.setDueOn(spoken == null ? null : DueDates.resolve(spoken, referenceDate(meeting)));
    }

    private static LocalDate referenceDate(Meeting meeting) {
        Instant when = meeting == null || meeting.getCreatedAt() == null
                ? Instant.now()
                : meeting.getCreatedAt();
        return when.atZone(ZoneOffset.UTC).toLocalDate();
    }

    /** Status plus the stamp that says when, which {@code status} alone cannot. */
    private static void applyStatus(MeetingActionItem item, String raw) {
        String status = requireStatus(raw);
        boolean wasDone = DONE.equals(item.getStatus());
        item.setStatus(status);
        if (DONE.equals(status) && !wasDone) {
            item.setCompletedAt(Instant.now());
        } else if (!DONE.equals(status)) {
            // Reopened. Leaving the old stamp would have the item claim it was
            // finished at a time it demonstrably was not.
            item.setCompletedAt(null);
        }
    }

    private static String requireStatus(String raw) {
        String s = raw == null ? "" : raw.trim().toUpperCase();
        if (!VALID_STATUSES.contains(s)) {
            throw ApiException.badRequest("status must be one of " + VALID_STATUSES);
        }
        return s;
    }

    /** The caller's name as transcripts spell it, lower-cased for matching. */
    private String myName(String userId) {
        String name = displayNameOf(userId);
        return name == null ? null : name.trim().toLowerCase();
    }

    private String displayNameOf(String userId) {
        return users.findById(userId)
                .map(UserEntity::getDisplayName)
                .filter(n -> !n.isBlank())
                .orElse(null);
    }

    private Map<String, String> titlesFor(List<MeetingActionItem> items) {
        // Nulls filtered out rather than fetched: since V36 an item may have no
        // meeting at all, and findAllById on a set containing null throws.
        Set<String> ids = items.stream()
                .map(MeetingActionItem::getMeetingId)
                .filter(java.util.Objects::nonNull)
                .collect(Collectors.toSet());
        return meetings.findAllById(ids).stream()
                .collect(Collectors.toMap(Meeting::getId, Meeting::getTitle, (a, b) -> a));
    }

    private Map<String, Integer> commentCounts(Collection<MeetingActionItem> items) {
        if (items.isEmpty()) {
            return Map.of();
        }
        Set<String> ids = items.stream().map(MeetingActionItem::getId).collect(Collectors.toSet());
        Map<String, Integer> counts = new HashMap<>();
        for (Object[] row : comments.countByActionItemIds(ids)) {
            counts.put((String) row[0], (int) count(row[1]));
        }
        return counts;
    }

    private static long count(Object value) {
        return value instanceof Number n ? n.longValue() : 0L;
    }

    private static String blankToNull(String s) {
        return (s == null || s.isBlank()) ? null : s.trim();
    }
}
