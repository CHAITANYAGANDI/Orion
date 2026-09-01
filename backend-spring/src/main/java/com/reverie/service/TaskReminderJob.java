package com.reverie.service;

import com.reverie.entity.MeetingActionItem;
import com.reverie.repository.MeetingActionItemRepository;
import com.reverie.security.TenantContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;

/**
 * The morning digest of what is due, and what is already late.
 *
 * <h2>Why this one is worth an email when the recap was not</h2>
 *
 * <p>A deadline is the only thing Reverie extracts that carries a clock. A
 * summary is a record — it is as useful next week as it is this morning, and it
 * is sitting in the app either way. A commitment somebody made out loud in a
 * meeting is different: it has a day attached, and the reader is not in
 * Reverie on that day, they are in their calendar and their inbox. Of
 * everything V56 removed, this is the one that was doing work the app could not
 * do for itself.
 *
 * <h2>Eight in the morning, UTC</h2>
 *
 * <p>The slot the old digest had, which the retention pass was deliberately
 * timed away from and which has been empty since V56.
 *
 * <h2>Two queries, not one per account</h2>
 *
 * <p>{@code dueByUser} is a grouped count over the whole table and answers
 * "who has anything at all" in a single round trip. Only those accounts are
 * then asked for their actual list. The alternative — {@code findDueThrough}
 * once per user — is a query per account per morning to discover that almost
 * none of them have anything, which is the cost that makes a digest job the
 * first thing to fall over as a product grows.
 *
 * <p>Both queries survived V56 unused. They were written for exactly this.
 *
 * <h2>Two instances, one digest</h2>
 *
 * <p>Nothing here elects a leader and nothing needs to. Two instances waking at
 * 08:00:00 both build the same list and both enqueue with the same key --
 * {@code task-reminder:{user}:{date}} -- and the unique index turns the second
 * into a no-op rather than a second message. The same property covers a single
 * instance restarted at 08:00:01 by a deploy.
 */
@Component
public class TaskReminderJob {

    private static final Logger log = LoggerFactory.getLogger(TaskReminderJob.class);

    private final MeetingActionItemRepository items;
    private final AccountMail mail;
    private final boolean enabled;

    public TaskReminderJob(MeetingActionItemRepository items,
                           AccountMail mail,
                           @Value("${reverie.mail.task-reminders:true}") boolean enabled) {
        this.items = items;
        this.mail = mail;
        this.enabled = enabled;
    }

    @Scheduled(cron = "${reverie.mail.task-reminder-cron:0 0 8 * * *}", zone = "UTC")
    public void send() {
        if (!enabled) {
            return;
        }
        try {
            TenantContext.asSystem(() -> {
                run(LocalDate.now(ZoneOffset.UTC));
                return null;
            });
        } catch (Exception e) {
            // The scheduler thread also carries the outbox relay and the
            // retention pass. Nothing here is worth taking those down.
            log.error("Deadline digest failed: {}", e.getMessage(), e);
        }
    }

    /** Package-private so a test can drive it with a fixed clock. */
    void run(LocalDate today) {
        // Tomorrow is the horizon: "due tomorrow" is what a morning digest can
        // still change, and anything already overdue is swept up by the same
        // bound because its date is further in the past.
        LocalDate through = today.plusDays(1);

        for (String userId : withSomethingDue(today, through)) {
            try {
                List<MeetingActionItem> due = items.findDueThrough(userId, through);
                if (!due.isEmpty()) {
                    mail.taskReminder(userId, due, today);
                }
            } catch (RuntimeException e) {
                log.warn("Could not build the digest for {}: {}", userId, e.toString());
            }
        }
    }

    /**
     * The accounts with anything due, from one grouped query.
     *
     * <p>The counts it also returns are not read. They are the reason the query
     * exists — it was written to answer the bell as well — and re-deriving the
     * split from the rows that come back next is cheaper than trusting two
     * numbers to still agree a moment later.
     */
    private List<String> withSomethingDue(LocalDate today, LocalDate through) {
        List<String> ids = new ArrayList<>();
        for (Object[] row : items.dueByUser(today, through)) {
            if (row.length > 0 && row[0] instanceof String id && !id.isBlank()) {
                ids.add(id);
            }
        }
        return ids;
    }
}
