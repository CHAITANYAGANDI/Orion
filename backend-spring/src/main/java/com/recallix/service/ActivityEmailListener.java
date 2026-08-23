package com.recallix.service;

import com.recallix.event.WorkspaceActivityEvent;
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
 * Runs the activity emails off the request thread.
 *
 * <p>Its own bean for the same three reasons as {@link RecapEmailListener} and
 * {@code @Async} means the work happens outside the
 * publishing transaction, so {@link ActivityEmailService} has to be reached
 * through its Spring proxy for {@code @Transactional} to take effect at all —
 * a self-call would silently write the daily stamp outside any transaction.
 * AFTER_COMMIT guarantees the comment or highlight being described is actually
 * on disk. And the tenant does not follow a thread hop, so it is re-established
 * from the event.
 *
 * <p>Nothing here is allowed to propagate. A highlight that saved is saved; a
 * mail server that refused the message about it is not a reason to tell the
 * user their highlight failed.
 */
@Component
public class ActivityEmailListener {

    private static final Logger log = LoggerFactory.getLogger(ActivityEmailListener.class);

    private final ActivityEmailService activity;

    public ActivityEmailListener(ActivityEmailService activity) {
        this.activity = activity;
    }

    @Async("postCommitExecutor")
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onActivity(WorkspaceActivityEvent event) {
        TenantContext.setUserId(event.userId());
        try {
            // UTC, matching the reminder job. A per-user day would need a
            // timezone Recallix does not store, and guessing one would make
            // "one a day" mean something different for every account.
            activity.send(event, LocalDate.now(ZoneOffset.UTC));
        } catch (Exception e) {
            log.warn("Activity email failed for {} ({}): {}",
                    event.kind(), event.subject(), e.toString());
        } finally {
            TenantContext.clear();
        }
    }
}
