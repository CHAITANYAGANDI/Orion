package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.common.IdGenerator;
import com.recallix.domain.NotificationKind;
import com.recallix.dto.NotificationResponse;
import com.recallix.dto.PageResponse;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingActionItem;
import com.recallix.entity.Notification;
import com.recallix.entity.UserEntity;
import com.recallix.repository.NotificationRepository;
import com.recallix.repository.UserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * What Recallix says about its own work.
 *
 * <p>Every wording lives in this one class. The alternative — each caller
 * writing its own sentence at the point the event happens — is how a product
 * ends up saying "Transcription complete", "Transcript is ready" and "Your
 * transcript has finished processing" in three places for the same event.
 *
 * <p><strong>Three rules keep the bell worth looking at.</strong>
 *
 * <p><em>Muted kinds are never written, not merely hidden.</em> Writing a row
 * and filtering it on read means switching a kind back on floods the list with
 * a month of things somebody had already decided they did not care about.
 *
 * <p><em>Recurring kinds carry a dedupe key.</em> An overdue task is overdue
 * again tomorrow and a shared link is opened by everyone it was sent to. Without
 * a key the list is a firehose, and a firehose is uninstalled by simply not
 * clicking the bell again.
 *
 * <p><em>Nothing here may break what it is reporting on.</em> A notification is
 * commentary. It is written inside the caller's transaction so that a rolled-back
 * meeting leaves no notification about itself, and the socket ping is deferred
 * to after that commit so a browser is never told about something that did not
 * end up happening.
 */
@Service
public class NotificationService {

    private static final Logger log = LoggerFactory.getLogger(NotificationService.class);

    /** Long enough to be a history, short enough that nobody scrolls it. */
    private static final int MAX_PAGE = 100;

    /** How many tasks a "you were assigned work" notification names before it summarises. */
    private static final int NAMED_TASKS = 2;

    private final NotificationRepository notifications;
    private final UserRepository users;
    private final NotificationPublisher publisher;

    public NotificationService(NotificationRepository notifications,
                               UserRepository users,
                               NotificationPublisher publisher) {
        this.notifications = notifications;
        this.users = users;
        this.publisher = publisher;
    }

    /* ------------------------------- reading ------------------------------ */

    @Transactional(readOnly = true)
    public PageResponse<NotificationResponse> list(String userId, boolean unreadOnly,
                                                   int page, int size) {
        Page<Notification> found = notifications.findForUser(userId, unreadOnly,
                PageRequest.of(Math.max(0, page), Math.min(Math.max(1, size), MAX_PAGE)));
        return PageResponse.from(found, found.getContent().stream()
                .map(NotificationResponse::from)
                .toList());
    }

    @Transactional(readOnly = true)
    public long unreadCount(String userId) {
        return notifications.countByUserIdAndReadAtIsNull(userId);
    }

    @Transactional
    public NotificationResponse markRead(String userId, String id, boolean read) {
        Notification n = notifications.findByIdAndUserId(id, userId)
                .orElseThrow(() -> ApiException.notFound("Notification not found"));
        n.setReadAt(read ? Instant.now() : null);
        return NotificationResponse.from(n);
    }

    @Transactional
    public int markAllRead(String userId) {
        return notifications.markAllRead(userId, Instant.now());
    }

    @Transactional
    public void delete(String userId, String id) {
        notifications.findByIdAndUserId(id, userId).ifPresent(notifications::delete);
    }

    @Transactional
    public int clear(String userId) {
        return notifications.deleteAllForUser(userId);
    }

    /* ------------------------------- writing ------------------------------ */

    /** A recording began — useful on a second tab, or on a phone in a pocket. */
    @Transactional
    public void recordingStarted(String userId) {
        emit(userId, NotificationKind.RECORDING_STARTED,
                "Recording started",
                "Recallix is capturing audio. It becomes a meeting when you stop.",
                null, null, "/record",
                // At most one an hour: starting, stopping and restarting while
                // finding a quiet room should not be three notifications.
                "hour:" + Instant.now().getEpochSecond() / 3600);
    }

    /**
     * A meeting entered the pipeline.
     *
     * @param because how it got here — "uploaded", "imported", "reprocessed"
     */
    @Transactional
    public void processingStarted(Meeting meeting, String because) {
        emit(meeting.getUserId(), NotificationKind.PROCESSING_STARTED,
                meeting.getTitle(),
                "Being " + because + ". We'll tell you when the notes are ready.",
                meeting.getId(), null, link(meeting), null);
    }

    @Transactional
    public void transcriptReady(Meeting meeting) {
        emit(meeting.getUserId(), NotificationKind.TRANSCRIPT_READY,
                meeting.getTitle(),
                "The transcript is ready to read and search.",
                meeting.getId(), null, link(meeting), null);
    }

    @Transactional
    public void summaryReady(Meeting meeting) {
        emit(meeting.getUserId(), NotificationKind.SUMMARY_READY,
                meeting.getTitle(),
                "The notes are written. Summary, decisions and action items are in.",
                meeting.getId(), null, link(meeting), null);
    }

    /**
     * The notes were rewritten under a different template.
     *
     * <p>Its own event rather than a second {@code SUMMARY_READY}, because it
     * is the only one of these somebody deliberately started and then walked
     * away from — and because "the notes are written" would be the wrong
     * sentence for notes that already existed.
     */
    @Transactional
    public void summaryRewritten(Meeting meeting, String template) {
        emit(meeting.getUserId(), NotificationKind.SUMMARY_READY,
                meeting.getTitle(),
                "The notes were rewritten as " + template + ".",
                meeting.getId(), null, link(meeting), null);
    }

    @Transactional
    public void processingFailed(Meeting meeting, String message) {
        emit(meeting.getUserId(), NotificationKind.PROCESSING_FAILED,
                meeting.getTitle(),
                (message == null || message.isBlank()
                        ? "Processing failed."
                        : "Processing failed: " + message.strip())
                        + " You can try again from the meeting page.",
                meeting.getId(), null, link(meeting), null);
    }

    @Transactional
    public void recapSent(Meeting meeting, String to) {
        emit(meeting.getUserId(), NotificationKind.RECAP_SENT,
                meeting.getTitle(),
                "Recap emailed to " + to + ".",
                meeting.getId(), null, link(meeting), null);
    }

    /**
     * A meeting handed you work by name.
     *
     * <p>The closest thing a one-account product has to "somebody mentioned
     * you", and the only one that is true: nobody typed your name into a
     * comment, but a meeting you were in committed you to something. Requires a
     * display name — without one there is no fact relating an account to a
     * "Priya" in a transcript.
     */
    @Transactional
    public void mentionedIn(Meeting meeting, List<MeetingActionItem> mine) {
        if (mine.isEmpty()) {
            return;
        }
        String detail = mine.stream().limit(NAMED_TASKS)
                .map(MeetingActionItem::getTitle)
                .collect(Collectors.joining("; "));
        if (mine.size() > NAMED_TASKS) {
            detail += " and " + (mine.size() - NAMED_TASKS) + " more";
        }
        emit(meeting.getUserId(), NotificationKind.MENTIONED_IN_MEETING,
                mine.size() == 1 ? "You were given an action item" : "You were given " + mine.size() + " action items",
                detail + " — from " + meeting.getTitle() + ".",
                meeting.getId(), mine.get(0).getId(), link(meeting) + "?tab=actions",
                // One per meeting: a reprocess must not say it again.
                "meeting:" + meeting.getId());
    }

    /** Work due today or in the next few days. One a day, whatever the count. */
    @Transactional
    public void tasksDue(String userId, int count, LocalDate today) {
        if (count <= 0) {
            return;
        }
        emit(userId, NotificationKind.ACTION_ITEM_DUE,
                count == 1 ? "1 action item due soon" : count + " action items due soon",
                "Due today or in the next few days.",
                null, null, "/action-items?view=soon",
                "day:" + today);
    }

    @Transactional
    public void tasksOverdue(String userId, int count, LocalDate today) {
        if (count <= 0) {
            return;
        }
        emit(userId, NotificationKind.ACTION_ITEM_OVERDUE,
                count == 1 ? "1 action item is overdue" : count + " action items are overdue",
                "Past their deadline and still open.",
                null, null, "/action-items?view=overdue",
                "day:" + today);
    }

    /**
     * Somebody outside the workspace opened a link.
     *
     * <p>Deduped to one a day per link. A meeting shared with a room of forty
     * people is opened forty times in five minutes, and forty notifications
     * about one act of sharing is the definition of noise.
     */
    @Transactional
    public void shareViewed(String userId, Meeting meeting, String shareId, LocalDate today) {
        emit(userId, NotificationKind.SHARE_VIEWED,
                meeting == null ? "A link you shared was opened" : meeting.getTitle(),
                "Someone opened the link you shared.",
                meeting == null ? null : meeting.getId(), null,
                meeting == null ? "/meetings" : link(meeting),
                "share:" + shareId + ":" + today);
    }

    /**
     * A retention rule deleted something.
     *
     * <p>One notification for the whole night's work rather than one per
     * meeting: a policy switched on over an old archive erases hundreds of
     * things on its first run, and a bell with three hundred rows in it is a
     * bell nobody reads the important row in.
     *
     * <p>Deduped by day for the same reason the digest is — the pass runs daily
     * and a retry after a failure must not say it twice — and deliberately not
     * mutable. See {@link NotificationKind#RETENTION_APPLIED}.
     *
     * @param recordings meetings whose audio was erased, notes intact
     * @param meetings   meetings erased entirely
     */
    @Transactional
    public void retentionApplied(String userId, int recordings, int meetings, LocalDate today) {
        if (recordings <= 0 && meetings <= 0) {
            return;
        }
        StringBuilder body = new StringBuilder("Your retention policy deleted ");
        if (recordings > 0) {
            body.append(count(recordings, "recording", "recordings"))
                    .append(recordings == 1 ? " (its notes are kept)" : " (their notes are kept)");
        }
        if (recordings > 0 && meetings > 0) {
            body.append(", and ");
        }
        if (meetings > 0) {
            body.append(count(meetings, "meeting", "meetings")).append(" in full");
        }
        // No link. This used to point at the retention dials on the privacy
        // tab so the reader could adjust the policy that had just deleted
        // something; those controls were removed, and a notification that
        // offers to take you somewhere and then does not is worse than one
        // that simply reports. The sentence still says what went.
        emit(userId, NotificationKind.RETENTION_APPLIED,
                "Retention deleted " + count(recordings + meetings, "item", "items"),
                body.append(". This cannot be undone.").toString(),
                null, null, null,
                "day:" + today);
    }

    /* ------------------------------- the rule ----------------------------- */

    /**
     * Write it down, unless it was switched off or has already been said.
     *
     * <p>Nothing in here throws at the caller. A notification is commentary on
     * work that has already succeeded, and a bell that cannot be written is not
     * a reason to fail an upload.
     */
    private void emit(String userId, NotificationKind kind, String title, String body,
                      String meetingId, String actionItemId, String link, String dedupeKey) {
        try {
            if (userId == null || userId.isBlank() || muted(userId, kind)) {
                return;
            }
            if (dedupeKey != null
                    && notifications.existsByUserIdAndKindAndDedupeKey(userId, kind, dedupeKey)) {
                return;
            }

            Notification n = new Notification();
            n.setId(IdGenerator.notification());
            n.setUserId(userId);
            n.setKind(kind);
            n.setTitle(trim(title));
            n.setBody(body);
            n.setMeetingId(meetingId);
            n.setActionItemId(actionItemId);
            n.setLink(link);
            n.setDedupeKey(dedupeKey);
            notifications.save(n);

            pingAfterCommit(userId);
        } catch (Exception e) {
            log.warn("Could not record a {} notification for {}: {}", kind, userId, e.toString());
        }
    }

    private boolean muted(String userId, NotificationKind kind) {
        if (!kind.mutable()) {
            return false;
        }
        UserEntity user = users.findById(userId).orElse(null);
        if (user == null) {
            return false;
        }
        Set<String> off = user.getMutedNotifications().stream()
                .filter(java.util.Objects::nonNull)
                .map(s -> s.trim().toUpperCase(Locale.ROOT))
                .collect(Collectors.toSet());
        return off.contains(kind.name());
    }

    /**
     * Ping the browser once the row is actually there.
     *
     * <p>Sent inside the transaction it would race the commit: the client would
     * be told to re-read and would read the state from before. Sent for a
     * transaction that later rolls back it would be a lie.
     */
    private void pingAfterCommit(String userId) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            publisher.ping(userId, notifications.countByUserIdAndReadAtIsNull(userId));
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                publisher.ping(userId, notifications.countByUserIdAndReadAtIsNull(userId));
            }
        });
    }

    private static String link(Meeting meeting) {
        return "/meetings/" + meeting.getId();
    }

    private static String count(int n, String one, String many) {
        return n + " " + (n == 1 ? one : many);
    }

    private static String trim(String title) {
        String value = title == null ? "" : title.strip();
        if (value.isEmpty()) {
            return "Untitled meeting";
        }
        return value.length() <= 300 ? value : value.substring(0, 297) + "...";
    }
}
