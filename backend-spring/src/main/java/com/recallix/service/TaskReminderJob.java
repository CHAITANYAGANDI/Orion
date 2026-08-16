package com.recallix.service;

import com.recallix.security.TenantContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.ZoneOffset;

/**
 * Fires the daily task-reminder digest.
 *
 * <p>A separate bean from the service it calls, for two reasons. The scheduler
 * runs on a thread with no authenticated user, so the work has to be wrapped in
 * {@link TenantContext#runAsSystem} — and a bean that both schedules itself and
 * establishes its own tenant context is a bean whose transactional boundary is
 * easy to get subtly wrong. Keeping the trigger separate also means the digest
 * can be sent on demand from a test without a clock.
 *
 * <p>Eight in the morning UTC, deliberately not configurable per user: a
 * send-time preference implies we know what morning means where they are, and
 * Recallix does not store a timezone. The hour is a property so an operator can
 * move it, and {@code recallix.tasks.reminders-enabled=false} turns the job off
 * entirely for environments that should never send mail.
 */
@Component
public class TaskReminderJob {

    private static final Logger log = LoggerFactory.getLogger(TaskReminderJob.class);

    private final TaskReminderService reminders;

    public TaskReminderJob(TaskReminderService reminders) {
        this.reminders = reminders;
    }

    @Scheduled(cron = "${recallix.tasks.reminder-cron:0 0 8 * * *}", zone = "UTC")
    public void sendDailyDigest() {
        LocalDate today = LocalDate.now(ZoneOffset.UTC);
        // Never let a failure here kill the scheduler's thread: a broken digest
        // must not take the outbox relay down with it.
        try {
            TenantContext.runAsSystem(() -> reminders.sendDue(today));
        } catch (RuntimeException e) {
            log.error("Task reminder digest failed: {}", e.getMessage(), e);
        }
        // Its own try: the bell is for everybody with work outstanding, and the
        // people who never opted into the email are exactly the ones who would
        // otherwise lose it to a mail-server failure.
        try {
            TenantContext.runAsSystem(() -> reminders.notifyDue(today));
        } catch (RuntimeException e) {
            log.error("Task reminder notifications failed: {}", e.getMessage(), e);
        }
    }
}
