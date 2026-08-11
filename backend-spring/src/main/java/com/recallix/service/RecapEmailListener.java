package com.recallix.service;

import com.recallix.event.MeetingReadyEvent;
import com.recallix.security.TenantContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

/**
 * Mails the recap once a meeting is ready.
 *
 * <p>Its own bean because {@code @Async} means this runs outside the publishing
 * transaction, so the service has to be called through its Spring proxy for
 * {@code @Transactional} to take effect. AFTER_COMMIT also guarantees the brief
 * the draft is built from is actually visible.
 */
@Component
public class RecapEmailListener {

    private static final Logger log = LoggerFactory.getLogger(RecapEmailListener.class);

    private final RecapEmailService recaps;

    public RecapEmailListener(RecapEmailService recaps) {
        this.recaps = recaps;
    }

    @Async("postCommitExecutor")
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onMeetingReady(MeetingReadyEvent event) {
        // Async: a different thread, so the request's tenant did not follow.
        // Set it from the event, or every read here matches nothing.
        TenantContext.setUserId(event.userId());
        try {
            recaps.sendIfEnabled(event.meetingId(), event.userId());
        } catch (Exception e) {
            // Never propagate: the meeting is complete and usable regardless of
            // whether its recap made it out.
            log.warn("Recap email errored for meeting {}: {}", event.meetingId(), e.toString(), e);
        } finally {
            TenantContext.clear();
        }
    }
}
