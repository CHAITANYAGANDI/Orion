package com.recallix.service;

import com.recallix.entity.Meeting;
import com.recallix.event.ShareViewedEvent;
import com.recallix.repository.MeetingRepository;
import com.recallix.security.TenantContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

import java.time.LocalDate;
import java.time.ZoneOffset;

/**
 * Tells the owner that a link of theirs was opened.
 *
 * <p>The one genuinely other-party event Recallix has. Everything else in the
 * notification list is the product reporting on its own work; this is somebody
 * you sent a link to actually reading it, which is the thing people check for
 * after sending one.
 *
 * <p>Its own bean, after commit, on another thread — the same shape as
 * {@link RecapEmailListener} and for the same three reasons. The share page is
 * unauthenticated so the tenant has to be established here; {@code @Async} means
 * the reader is not kept waiting on a notification; and a failure — including
 * losing the race for the day's dedupe key — must not turn a public page into
 * an error.
 */
@Component
public class ShareViewListener {

    private static final Logger log = LoggerFactory.getLogger(ShareViewListener.class);

    private final NotificationService notifications;
    private final MeetingRepository meetings;

    public ShareViewListener(NotificationService notifications, MeetingRepository meetings) {
        this.notifications = notifications;
        this.meetings = meetings;
    }

    // No @Transactional here: Spring rejects it on an AFTER_COMMIT listener
    // unless it opens a new one, and there is nothing to hold open anyway —
    // the read and the write below each want their own, and a failure in
    // either must not roll back the other.
    @Async("postCommitExecutor")
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onShareViewed(ShareViewedEvent event) {
        TenantContext.setUserId(event.ownerUserId());
        try {
            Meeting meeting = meetings.findById(event.meetingId()).orElse(null);
            notifications.shareViewed(event.ownerUserId(), meeting, event.shareId(),
                    LocalDate.now(ZoneOffset.UTC));
        } catch (Exception e) {
            log.warn("Share view notification failed for {}: {}", event.shareId(), e.toString());
        } finally {
            TenantContext.clear();
        }
    }
}
