package com.reverie.service;

import com.reverie.entity.UserEntity;
import com.reverie.repository.UserRepository;
import com.reverie.security.TenantContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.NavigableMap;

/**
 * Warns an account before its retention policy deletes something.
 *
 * <h2>The only message here that prevents a loss</h2>
 *
 * <p>Every other thing Reverie sends reports something that has already
 * happened. This one arrives while there is still something to do about it, and
 * that is the whole justification for it interrupting anybody: a retention
 * policy is chosen once, in a settings page, and then fires unattended months
 * later — precisely when whoever chose it has stopped thinking about it. The
 * app cannot tell them, because they are not going to open the app.
 *
 * <h2>One warning per deletion date, not one per week</h2>
 *
 * <p>This is the correction the audit asked for. The rule used to be "at most
 * one warning every seven days", deduplicated by the day the warning was
 * <em>sent</em>. That fails in the exact case the message exists for:
 *
 * <pre>
 *   Mon  meetings A and B are due on the 20th   -> warned
 *   Tue  meeting C crosses the horizon, due 21st -> suppressed, six days to go
 *   ...
 *   21st C is deleted. Nobody was ever told.
 * </pre>
 *
 * <p>So the unit is the <b>batch</b>, meaning everything the policy will delete
 * on one particular day, and the message is keyed to that day —
 * {@code retention-warning:{user}:{date}}. Two batches a day apart get two
 * warnings. The same batch gets one however many times this runs, because the
 * key is unique in {@code mail_outbox} and enqueueing is
 * {@code ON CONFLICT DO NOTHING}.
 *
 * <h2>Why it scans a window rather than a single day</h2>
 *
 * <p>Looking only at {@code today + 7} would be enough if this job never missed
 * a morning. It will miss mornings — a deploy, an outage, a scheduler that was
 * off. Scanning the whole week means a missed day is caught up the next time it
 * runs, and the key is what makes catching up safe: a batch already warned about
 * is a row that already exists.
 *
 * <p>Two in the morning UTC, an hour before the pass that does the deleting.
 * They look at different days so the order does not matter, but a job that warns
 * about deletions has no business running after them.
 */
@Component
public class RetentionWarningJob {

    private static final Logger log = LoggerFactory.getLogger(RetentionWarningJob.class);

    /** A week. Long enough to act, short enough to still be true when it arrives. */
    public static final int WARN_DAYS = 7;

    private final UserRepository users;
    private final RetentionService retention;
    private final AccountMail mail;
    private final boolean enabled;

    public RetentionWarningJob(UserRepository users,
                               RetentionService retention,
                               AccountMail mail,
                               @Value("${reverie.retention.enabled:true}") boolean enabled) {
        this.users = users;
        this.retention = retention;
        this.mail = mail;
        this.enabled = enabled;
    }

    @Scheduled(cron = "${reverie.mail.retention-warning-cron:0 0 2 * * *}", zone = "UTC")
    public void warn() {
        if (!enabled) {
            return;
        }
        try {
            TenantContext.runAsSystem(() -> run(LocalDate.now(ZoneOffset.UTC)));
        } catch (Exception e) {
            // Never kill the scheduler thread: the outbox relays, the retention
            // pass and the deadline digest run on it too.
            log.error("Retention warning pass failed: {}", e.getMessage(), e);
        }
    }

    /** Package-private so a test can drive it with a fixed clock. */
    void run(LocalDate today) {
        LocalDate from = today.plusDays(1);
        LocalDate through = today.plusDays(WARN_DAYS);

        for (UserEntity user : users.findWithRetentionPolicy()) {
            if (!user.isRetentionWarningEmail()) {
                // Cheap skip before the per-user scan. The switch is off for
                // every account until somebody turns it on.
                continue;
            }
            try {
                NavigableMap<LocalDate, RetentionService.Due> batches =
                        retention.upcoming(user, from, through);
                for (Map.Entry<LocalDate, RetentionService.Due> batch : batches.entrySet()) {
                    mail.retentionWarning(user, batch.getKey(), batch.getValue());
                }
            } catch (RuntimeException e) {
                // One account's failure is not the rest of them. Nothing is
                // half-written: each enqueue is its own statement, and a batch
                // that was queued stays queued.
                log.warn("Could not warn {} about retention: {}", user.getId(), e.toString());
            }
        }
    }
}
