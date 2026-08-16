package com.recallix.service;

import com.recallix.domain.DueStatus;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingActionItem;
import com.recallix.entity.UserEntity;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.UserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * One mail a day about what is late and what is about to be.
 *
 * <p>Deliberately a digest and not a notification per task. A tracker fed by
 * every meeting produces bursts — five items land at once when a planning
 * session is processed — and five separate emails about them is how somebody
 * builds a filter rule and stops reading any of it.
 *
 * <p>Three things keep it from becoming noise. It is opt-in. It sends nothing at
 * all when nothing is due, so an empty week is silent rather than seven "you
 * have 0 tasks" emails. And it stamps the day it sent on the user, so a restart
 * or a redeploy at the wrong minute cannot mail the same digest twice — the
 * second pass simply does not select them.
 */
@Service
public class TaskReminderService {

    private static final Logger log = LoggerFactory.getLogger(TaskReminderService.class);

    private static final DateTimeFormatter DAY = DateTimeFormatter.ofPattern("d MMM");

    /** Not a hard limit on the tracker — a limit on how much of it is worth mailing. */
    private static final int MAX_LISTED = 25;

    private final UserRepository users;
    private final MeetingActionItemRepository actionItems;
    private final MeetingRepository meetings;
    private final EmailService email;
    private final AuditService audit;
    private final NotificationService notifications;
    private final String frontendUrl;

    public TaskReminderService(UserRepository users,
                               MeetingActionItemRepository actionItems,
                               MeetingRepository meetings,
                               EmailService email,
                               AuditService audit,
                               NotificationService notifications,
                               @Value("${app.frontend-url:http://localhost:3000}") String frontendUrl) {
        this.users = users;
        this.actionItems = actionItems;
        this.meetings = meetings;
        this.email = email;
        this.audit = audit;
        this.notifications = notifications;
        this.frontendUrl = frontendUrl.endsWith("/")
                ? frontendUrl.substring(0, frontendUrl.length() - 1)
                : frontendUrl;
    }

    /**
     * Send today's digests.
     *
     * <p>One transaction across every user who is owed one. That is right at the
     * scale this runs at — a workspace is one account — and the alternative,
     * a transaction per user, needs a second bean to get past self-invocation
     * for no benefit anybody can currently measure.
     *
     * @return how many messages were sent
     */
    @Transactional
    public int sendDue(LocalDate today) {
        List<UserEntity> due = users.findAwaitingTaskReminder(today);
        int sent = 0;
        for (UserEntity user : due) {
            if (sendFor(user, today)) {
                sent++;
            }
        }
        if (sent > 0) {
            log.info("Sent {} task reminder digest(s).", sent);
        }
        return sent;
    }

    /**
     * Put today's deadlines in the bell, for everybody — not only the people
     * who asked for the email.
     *
     * <p>Separate from {@link #sendDue} on purpose. Mailing somebody who did not
     * ask is spam; a row in their own notification list is not, and the two
     * audiences are genuinely different — most people want to see what is late
     * without wanting a daily message about it.
     *
     * <p>Two notifications rather than one, because "3 overdue" and "3 due this
     * week" prompt entirely different behaviour, and a merged sentence reads as
     * neither. Both carry the day as their dedupe key, so a redeploy at the
     * wrong minute cannot say it twice.
     *
     * @return how many users were notified
     */
    @Transactional
    public int notifyDue(LocalDate today) {
        int notified = 0;
        for (Object[] row : actionItems.dueByUser(today, today.plusDays(DueStatus.SOON_DAYS))) {
            String userId = (String) row[0];
            int overdue = count(row[1]);
            int soon = count(row[2]);
            notifications.tasksOverdue(userId, overdue, today);
            notifications.tasksDue(userId, soon, today);
            if (overdue > 0 || soon > 0) {
                notified++;
            }
        }
        return notified;
    }

    private static int count(Object value) {
        return value instanceof Number n ? n.intValue() : 0;
    }

    private boolean sendFor(UserEntity user, LocalDate today) {
        String to = user.effectiveRecapEmail();
        if (to == null || to.isBlank()) {
            log.warn("User {} enabled task reminders but has no address on file.", user.getId());
            return false;
        }

        List<MeetingActionItem> items = actionItems.findDueThrough(
                user.getId(), today.plusDays(DueStatus.SOON_DAYS));
        if (items.isEmpty()) {
            // Nothing is due. Silence is the correct message; stamping the day
            // anyway would be a lie about having sent one.
            return false;
        }

        Map<String, String> titles = meetingTitles(items);
        String body = compose(user, items, titles, today);
        boolean ok = email.send(to, subject(items, today), body);
        if (ok) {
            user.setTaskReminderSentOn(today);
            audit.record(user.getId(), "TASK_REMINDER_SENT", "user", user.getId());
        }
        return ok;
    }

    /**
     * The subject line leads with what is already late.
     *
     * <p>It is the only part most people read, and "3 tasks are overdue" is a
     * different message from "3 tasks this week" even when the list underneath
     * is identical.
     */
    private static String subject(List<MeetingActionItem> items, LocalDate today) {
        long overdue = items.stream().filter(a -> a.getDueOn().isBefore(today)).count();
        long todayCount = items.stream().filter(a -> a.getDueOn().isEqual(today)).count();

        if (overdue > 0) {
            return overdue == 1
                    ? "1 action item is overdue"
                    : overdue + " action items are overdue";
        }
        if (todayCount > 0) {
            return todayCount == 1 ? "1 action item is due today" : todayCount + " action items due today";
        }
        return items.size() == 1 ? "1 action item due soon" : items.size() + " action items due soon";
    }

    private String compose(UserEntity user, List<MeetingActionItem> items,
                           Map<String, String> titles, LocalDate today) {
        Map<String, List<MeetingActionItem>> groups = new LinkedHashMap<>();
        groups.put("Overdue", new ArrayList<>());
        groups.put("Due today", new ArrayList<>());
        groups.put("Coming up", new ArrayList<>());
        for (MeetingActionItem a : items) {
            LocalDate on = a.getDueOn();
            String group = on.isBefore(today) ? "Overdue" : on.isEqual(today) ? "Due today" : "Coming up";
            groups.get(group).add(a);
        }

        StringBuilder sb = new StringBuilder();
        String name = user.getDisplayName();
        sb.append(name == null || name.isBlank() ? "Here is where your action items stand.\n"
                : "Hi " + name.trim() + " — here is where your action items stand.\n");

        int listed = 0;
        for (Map.Entry<String, List<MeetingActionItem>> group : groups.entrySet()) {
            if (group.getValue().isEmpty()) {
                continue;
            }
            sb.append("\n").append(group.getKey().toUpperCase())
                    .append(" (").append(group.getValue().size()).append(")\n");
            for (MeetingActionItem a : group.getValue()) {
                if (listed >= MAX_LISTED) {
                    break;
                }
                listed++;
                sb.append("  - ").append(a.getTitle()).append("\n");
                sb.append("    ").append(describe(a, titles, today)).append("\n");
            }
        }
        if (items.size() > listed) {
            sb.append("\n…and ").append(items.size() - listed).append(" more.\n");
        }

        sb.append("\nOpen your action items: ").append(frontendUrl).append("/action-items\n");
        sb.append("\n—\nSent by Recallix because task reminders are on. "
                + "Turn them off in Settings → Action items.");
        return sb.toString();
    }

    /** "Priya · 3 days late · Sprint planning" — owner, urgency, and where it came from. */
    private static String describe(MeetingActionItem a, Map<String, String> titles, LocalDate today) {
        List<String> parts = new ArrayList<>();
        if (a.getOwnerName() != null && !a.getOwnerName().isBlank()) {
            parts.add(a.getOwnerName().trim());
        }
        parts.add(lateness(a.getDueOn(), today));
        String meeting = titles.get(a.getMeetingId());
        if (meeting != null) {
            parts.add(meeting);
        }
        return String.join(" · ", parts);
    }

    private static String lateness(LocalDate dueOn, LocalDate today) {
        long days = ChronoUnit.DAYS.between(today, dueOn);
        if (days == 0) {
            return "due today";
        }
        if (days == 1) {
            return "due tomorrow";
        }
        if (days > 1) {
            return "due " + DAY.format(dueOn);
        }
        // "due 12 Aug" alone makes the reader do the arithmetic that decides
        // whether they care. The number of days is the point.
        long late = -days;
        return late == 1 ? "1 day late (" + DAY.format(dueOn) + ")"
                : late + " days late (" + DAY.format(dueOn) + ")";
    }

    private Map<String, String> meetingTitles(List<MeetingActionItem> items) {
        Set<String> ids = items.stream()
                .map(MeetingActionItem::getMeetingId)
                .collect(Collectors.toSet());
        return meetings.findAllById(ids).stream()
                .collect(Collectors.toMap(Meeting::getId, Meeting::getTitle, (a, b) -> a));
    }
}
