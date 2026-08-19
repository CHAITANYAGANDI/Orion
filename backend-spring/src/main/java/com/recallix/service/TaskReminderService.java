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

import java.time.DayOfWeek;
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
 * Two mails about deadlines, and never both on the same morning.
 *
 * <p>"Event reminder" goes out every morning and looks three days ahead: what is
 * late, and what needs doing now. "Weekly digest" goes out on Mondays and looks
 * a full week ahead. They were one setting with a cadence dropdown until V43,
 * which made them exclusive — and they are not two settings of one message, they
 * are two messages. A morning prompt and a Monday review answer different
 * questions, and people reasonably want both.
 *
 * <p>On a Monday with both switched on, only the review sends. Its window is the
 * superset, so nothing is lost, and two mails a minute apart drawn from
 * overlapping lists reads as a bug rather than as two features working.
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

    /** How far ahead the Monday review looks. The rest of the week, and no further. */
    private static final int WEEK_DAYS = 7;

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
            Digest digest = owed(user, today);
            if (digest == Digest.NONE) {
                continue;
            }
            if (sendFor(user, today, digest)) {
                sent++;
            }
        }
        if (sent > 0) {
            log.info("Sent {} task reminder digest(s).", sent);
        }
        return sent;
    }

    /** Which of the two messages a user is owed today, if either. */
    private enum Digest {
        NONE,
        /** "Event reminder": overdue and the next few days. Every morning. */
        DAILY,
        /** "Weekly digest": overdue and the whole week ahead. Mondays. */
        WEEKLY
    }

    /**
     * Which message this user is owed on this date (V43).
     *
     * <p>The master email switch is checked here rather than in the query, so
     * that turning email off never silently loses the {@code
     * task_reminder_sent_on} bookkeeping that stops a double send.
     *
     * <p><strong>Monday belongs to the review.</strong> Somebody with both
     * switches on would otherwise get two messages within the same minute,
     * drawn from overlapping lists, and the pair reads as a bug rather than as
     * two features working. The weekly one wins because it is the superset: its
     * window is the whole week ahead, so nothing the daily message would have
     * said is lost by sending it instead.
     *
     * <p>Monday is chosen rather than configurable for the same reason the send
     * hour is: Recallix stores no timezone, so it cannot honour "my Monday" any
     * better than it can honour "my morning".
     *
     * <p>Either message is silent when nothing is due. An empty week produces
     * nothing rather than "you have 0 tasks".
     */
    private static Digest owed(UserEntity user, LocalDate today) {
        if (!user.isEmailsEnabled()) {
            return Digest.NONE;
        }
        if (user.isWeeklyDigest() && today.getDayOfWeek() == DayOfWeek.MONDAY) {
            return Digest.WEEKLY;
        }
        return user.isTaskReminders() ? Digest.DAILY : Digest.NONE;
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

    private boolean sendFor(UserEntity user, LocalDate today, Digest digest) {
        String to = user.effectiveRecapEmail();
        if (to == null || to.isBlank()) {
            log.warn("User {} enabled task reminders but has no address on file.", user.getId());
            return false;
        }

        // The window is what actually separates the two messages. A morning
        // prompt asks what needs doing now; a Monday review asks what the week
        // holds, and a three-day horizon on a Monday would leave Thursday out of
        // "your week" entirely.
        int horizon = digest == Digest.WEEKLY ? WEEK_DAYS : DueStatus.SOON_DAYS;
        List<MeetingActionItem> items = actionItems.findDueThrough(
                user.getId(), today.plusDays(horizon));
        if (items.isEmpty()) {
            // Nothing is due. Silence is the correct message; stamping the day
            // anyway would be a lie about having sent one.
            return false;
        }

        Map<String, String> titles = meetingTitles(items);
        String body = compose(user, items, titles, today, digest);
        boolean ok = email.send(to, subject(items, today, digest), body);
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
    private static String subject(List<MeetingActionItem> items, LocalDate today, Digest digest) {
        long overdue = items.stream().filter(a -> a.getDueOn().isBefore(today)).count();
        long todayCount = items.stream().filter(a -> a.getDueOn().isEqual(today)).count();

        // The review says what it is even when nothing is late, because "2
        // action items due soon" arriving every Monday reads as the daily mail
        // misfiring rather than as the weekly one working.
        if (digest == Digest.WEEKLY && overdue == 0) {
            return "Your week: " + items.size() + (items.size() == 1 ? " action item" : " action items");
        }
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
                           Map<String, String> titles, LocalDate today, Digest digest) {
        Map<String, List<MeetingActionItem>> groups = new LinkedHashMap<>();
        groups.put("Overdue", new ArrayList<>());
        groups.put("Due today", new ArrayList<>());
        groups.put(digest == Digest.WEEKLY ? "Later this week" : "Coming up", new ArrayList<>());
        String ahead = digest == Digest.WEEKLY ? "Later this week" : "Coming up";
        for (MeetingActionItem a : items) {
            LocalDate on = a.getDueOn();
            String group = on.isBefore(today) ? "Overdue" : on.isEqual(today) ? "Due today" : ahead;
            groups.get(group).add(a);
        }

        StringBuilder sb = new StringBuilder();
        String name = user.getDisplayName();
        String opening = digest == Digest.WEEKLY
                ? "here is the week ahead."
                : "here is where your action items stand.";
        sb.append(name == null || name.isBlank()
                ? Character.toUpperCase(opening.charAt(0)) + opening.substring(1) + "\n"
                : "Hi " + name.trim() + " — " + opening + "\n");

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
        // Name the switch that sent it, not a switch that sounds like it. The
        // two messages come from two rows on the settings page, and a footer
        // that pointed at the wrong one would send somebody to turn off the
        // mail they wanted to keep.
        sb.append("\n—\nSent by Recallix because ")
                .append(digest == Digest.WEEKLY ? "\"Weekly digest\"" : "\"Event reminder\"")
                .append(" is on. Turn it off in Account Settings → Emails.");
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
