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
 * Runs Meeting Memory reconciliation once a meeting is fully ready.
 *
 * <p>Deliberately a separate bean from {@link MemoryService}: the listener is
 * {@code @Async}, so it runs outside the publishing transaction and must call
 * the service through its Spring proxy for {@code @Transactional} to apply.
 * Firing AFTER_COMMIT also guarantees the brief is visible to the new
 * transaction — reconciliation reads the action items the callback just wrote.
 */
@Component
public class MemoryReconciliationListener {

    private static final Logger log = LoggerFactory.getLogger(MemoryReconciliationListener.class);

    private final MemoryService memory;

    public MemoryReconciliationListener(MemoryService memory) {
        this.memory = memory;
    }

    @Async("memoryExecutor")
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onMeetingReady(MeetingReadyEvent event) {
        // A fresh pool thread: the request's tenant did not come with it, so
        // every query here would otherwise match nothing under row-level
        // security. The event carries the owner, so set it explicitly rather
        // than bypassing policies — this work is genuinely on one user's behalf.
        TenantContext.setUserId(event.userId());
        try {
            memory.reconcileMeeting(event.meetingId(), event.userId());
        } catch (Exception e) {
            // Never propagate: the meeting is already complete and usable.
            log.warn("Memory reconciliation errored for meeting {}: {}",
                    event.meetingId(), e.toString(), e);
        } finally {
            TenantContext.clear();
        }
    }
}
