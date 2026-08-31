package com.orion.service;

import com.orion.common.IdGenerator;
import com.orion.entity.Meeting;
import com.orion.entity.MeetingActionItem;
import com.orion.entity.UserEntity;
import com.orion.repository.MailOutboxRepository;
import com.orion.repository.MeetingRepository;
import com.orion.repository.UserRepository;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;

/**
 * The seven things Recallix will write to you about, and when the intent to
 * write them is committed.
 *
 * <h2>Nothing here sends anything</h2>
 *
 * <p>Every method writes a row to {@code mail_outbox} and returns.
 * {@link MailDispatcher} does the sending, later, on its own schedule, with
 * retries. That separation is the whole design and it exists because of one
 * failure this used to have:
 *
 * <p><em>The retention pass deletes a night's meetings. The send is attempted
 * inline. Resend is unreachable for ninety seconds. The message is lost for
 * good — tomorrow's pass computes tomorrow's deletions and nothing ever
 * mentions tonight's again.</em> The account holder lost data and was never
 * told, and every stamp and guard behaved exactly as written.
 *
 * <p>So the rule is: <b>the irreversible act and the intent to report it commit
 * together, or neither does.</b> These methods are called from inside the
 * transaction that does the deleting, the charging, the closing — not after it,
 * and not in a separate one. An enqueue that fails takes the transaction down
 * with it, which is correct: a deletion nobody can be told about should not
 * happen.
 *
 * <h2>Which means there are no "already sent" stamps</h2>
 *
 * <p>An earlier draft had five date columns on {@code users}, written after a
 * successful send. That is at-most-once, and every message here reports
 * something irreversible. The unique {@code dedupe_key} on the outbox row
 * replaces all of them: enqueueing twice is a no-op at the database, so a
 * restart, a second scheduler instance and a retried callback all converge on
 * one message.
 *
 * <h2>What may go in the body, and what may not</h2>
 *
 * <p>A queued row holds an address, a subject and two bodies, in a table with
 * no foreign key to anything, and it outlives the account it belongs to — the
 * closure notice is delivered after {@code closeAccount} has erased everything
 * else. It is therefore one of the very few places in Recallix where personal
 * data survives erasure, and what goes into it is a decision rather than a
 * convenience.
 *
 * <p>The rule: <b>the minimum that makes the message actionable, and nothing
 * that was said in a meeting.</b> In practice that is counts, dates, a meeting
 * title, and an action-item title — the last two because a message naming
 * neither is not a message anybody can act on. Deliberately absent, and to stay
 * absent: transcript text, summary text, {@code sourceSentence} (the quoted
 * line a task was extracted from), speaker names, and anything at all from a
 * recording. Links carry ids, so the app remains the place the content lives.
 *
 * <p>Nothing here touches a credential; see {@link MailError} for the one path
 * that could have stored one, and what stops it.
 *
 * <h2>The test each of these had to pass</h2>
 *
 * <p>V56 deleted every email this product sent, and it was right to — what it
 * deleted reported things the reader could see by opening the app. The test
 * here is not "is this worth knowing" but: <b>does this reach somebody who is
 * not in Recallix, about something they cannot see from outside it, while they
 * can still do something about it?</b>
 */
@Service
public class AccountMail {

    /** "12 March 2026". The year is present: these can be months out. */
    private static final DateTimeFormatter DAY =
            DateTimeFormatter.ofPattern("d MMMM yyyy", Locale.ENGLISH);

    private final MailOutboxRepository outbox;
    private final UserRepository users;
    private final MeetingRepository meetings;
    private final String appUrl;
    private final int notesMinSeconds;

    public AccountMail(MailOutboxRepository outbox,
                       UserRepository users,
                       MeetingRepository meetings,
                       @Value("${app.frontend-url:http://localhost:3000}") String appUrl,
                       @Value("${orion.mail.notes-min-seconds:900}") int notesMinSeconds) {
        this.outbox = outbox;
        this.users = users;
        this.meetings = meetings;
        this.appUrl = appUrl == null ? "" : appUrl.replaceAll("/+$", "");
        this.notesMinSeconds = notesMinSeconds;
    }

    /* ------------------------------------------------------------------ */
    /* 2. Retention is about to erase something                           */
    /* ------------------------------------------------------------------ */

    /**
     * One warning per impending deletion <em>date</em>.
     *
     * <p>The key is the date the deletion lands, not the day the warning was
     * written, and that is the correction this method exists for. The previous
     * rule was "at most one warning a week", which is wrong in a way that only
     * shows up in the case the message is for: warn on Monday about the batch
     * due next Monday, and the batch that crosses the horizon on Tuesday is
     * suppressed for six days — by which time it has been deleted, unwarned.
     *
     * <p>Keyed to the event instead, two batches a day apart each get their own
     * warning, and neither can get a second one however many times the job runs.
     * The window the caller scans is a week, so a morning the job did not run is
     * caught up rather than skipped.
     *
     * <p>The only message here that prevents an irreversible loss instead of
     * reporting one. A retention policy is set once and fires unattended months
     * later, precisely when whoever set it has stopped thinking about it.
     */
    public void retentionWarning(UserEntity user, LocalDate deletesOn, RetentionService.Due due) {
        if (!user.isRetentionWarningEmail() || due == null || !due.any()) {
            return;
        }
        String when = deletesOn.format(DAY);
        String subject = "Recallix deletes " + count(due.recordings() + due.meetings(), "item", "items")
                + " on " + when;
        String lead = "On " + when + " your retention policy will permanently delete "
                + itemised(due.recordings(), due.meetings()) + ". This cannot be undone.";
        String act = "If you want to keep any of it, change your retention policy or export the "
                + "meetings before then.";

        /*
         * Expires at midnight on the day itself. After that it is not a late
         * warning, it is a wrong one -- the deletion has happened and the
         * confirmation, already queued by the pass, is the honest message.
         */
        enqueue("retention-warning:" + user.getId() + ":" + deletesOn, user,
                subject, lead, act, "Retention settings", settingsUrl(),
                "You are getting this because retention warnings are on.",
                MailLifetime.retentionWarning(deletesOn));
    }

    /* ------------------------------------------------------------------ */
    /* 3. Retention erased something                                      */
    /* ------------------------------------------------------------------ */

    /**
     * One message per night's work, never one per meeting.
     *
     * <p>Called from inside the pass's transaction, so the row that says "tell
     * them" commits with the deletions it describes. If the pass rolls back
     * there is no message, and if the provider is down the message waits.
     */
    public void retentionApplied(String userId, int recordings, int meetingCount, LocalDate today) {
        if (recordings <= 0 && meetingCount <= 0) {
            return;
        }
        UserEntity user = users.findById(userId).orElse(null);
        if (user == null || !user.isRetentionAppliedEmail()) {
            return;
        }
        String subject = "Retention deleted " + count(recordings + meetingCount, "item", "items");
        String lead = "Your retention policy deleted " + itemised(recordings, meetingCount)
                + ". This cannot be undone.";
        String act = "The policy that did this is on your settings page, and it will run again "
                + "tomorrow night.";

        // A record, not a prompt. That data was deleted is as true in
        // September as it was in June, and this may be the only notice of it.
        enqueue("retention-applied:" + userId + ":" + today, user,
                subject, lead, act, "Retention settings", settingsUrl(),
                "You are getting this because retention notices are on.",
                MailLifetime.record(Instant.now()));
    }

    /* ------------------------------------------------------------------ */
    /* 5. Action items due tomorrow, and overdue ones                     */
    /* ------------------------------------------------------------------ */

    /**
     * One digest a day, and nothing at all when the list is empty.
     *
     * <p>An empty digest is what turns a useful sender into a filtered one, so
     * there is no "nothing due today" edition.
     */
    public void taskReminder(String userId, List<MeetingActionItem> items, LocalDate today) {
        if (items == null || items.isEmpty()) {
            return;
        }
        UserEntity user = users.findById(userId).orElse(null);
        if (user == null || !user.isTaskReminderEmail()) {
            return;
        }
        long overdue = items.stream().filter(a -> a.getDueOn().isBefore(today)).count();
        long soon = items.size() - overdue;

        String subject = overdue > 0 && soon > 0
                ? count((int) overdue, "task", "tasks") + " overdue, " + soon + " due"
                : overdue > 0
                    ? count((int) overdue, "task", "tasks") + " overdue"
                    : count((int) soon, "task", "tasks") + " due";

        StringBuilder plain = new StringBuilder();
        StringBuilder rows = new StringBuilder();
        for (MeetingActionItem item : items) {
            boolean late = item.getDueOn().isBefore(today);
            String due = late ? "overdue since " + item.getDueOn().format(DAY)
                              : "due " + item.getDueOn().format(DAY);
            plain.append("- ").append(item.getTitle()).append(" (").append(due).append(")\n")
                    .append("  ").append(meetingUrl(item.getMeetingId())).append("\n");
            rows.append("<tr><td style=\"padding:8px 0;border-bottom:1px solid #e8e4dc\">")
                    .append("<a href=\"").append(meetingUrl(item.getMeetingId()))
                    .append("\" style=\"color:#1a1a1a;text-decoration:none;font-weight:500\">")
                    .append(escape(item.getTitle())).append("</a><br>")
                    .append("<span style=\"font-size:13px;color:")
                    .append(late ? "#b3261e" : "#6b6259").append("\">")
                    .append(escape(due)).append("</span></td></tr>");
        }

        String lead = "From your meetings:";
        String html = shell(subject,
                "<p style=\"margin:0 0 8px\">" + lead + "</p>"
                        + "<table style=\"width:100%;border-collapse:collapse\">" + rows + "</table>",
                "Open Recallix", appUrl,
                "You are getting this because deadline reminders are on.");

        // "Two tasks are due tomorrow" delivered the day after tomorrow is not
        // a reminder, and the tasks are in the app where the reader can see them.
        write("task-reminder:" + userId + ":" + today, user.getEmail(), userId, subject,
                lead + "\n\n" + plain + "\n" + appUrl + "\n", html,
                MailLifetime.taskReminder(today));
    }

    /* ------------------------------------------------------------------ */
    /* 6. Your notes are ready — long recordings only                     */
    /* ------------------------------------------------------------------ */

    /**
     * Above a duration threshold, never below it.
     *
     * <p>A thirty-second memo finishes processing before the reader has left
     * the page, and mailing that is the V56 recap all over again — a message
     * about something already on screen. A ninety-minute recording takes
     * minutes, by which time the tab is closed.
     *
     * <p>Keyed to the meeting, so a reprocess — which re-raises every effect
     * behind it with a higher attempt number — does not mail the notes again.
     */
    public void notesReady(String meetingId) {
        Meeting meeting = meetings.findById(meetingId).orElse(null);
        if (meeting == null) {
            return;
        }
        Integer seconds = meeting.getDurationSeconds();
        if (seconds == null || seconds < notesMinSeconds) {
            return;
        }
        UserEntity user = users.findById(meeting.getUserId()).orElse(null);
        if (user == null || !user.isNotesReadyEmail()) {
            return;
        }
        String title = title(meeting);
        String subject = "Your notes for \"" + title + "\" are ready";
        String lead = "The transcript and summary for " + title + " ("
                + minutes(seconds) + ") are finished.";
        String act = "Everything in it is searchable, and you can ask questions of it.";

        enqueue("notes-ready:" + meeting.getId(), user,
                subject, lead, act, "Open the meeting", meetingUrl(meeting.getId()),
                "You are getting this because notes-ready mail is on for long recordings.",
                MailLifetime.notesReady(Instant.now()));
    }

    /* ------------------------------------------------------------------ */
    /* 8 and 9. The allowance                                             */
    /* ------------------------------------------------------------------ */

    /**
     * Nearly spent, then spent. Each once in the life of an account.
     *
     * <p>There is nothing to buy, which is exactly what makes both of these
     * honest rather than an upsell. The first changes what somebody chooses to
     * record while they still have the choice; the second has no switch,
     * because "you're out" reads as "your account is closed" unless something
     * says otherwise.
     *
     * <p>"Once, ever" is the unique key, not a column: an account cannot cross
     * 85% twice, and the key means it cannot be told twice either.
     */
    public void allowance(String userId, int used, int allowance) {
        if (allowance <= 0) {
            return;
        }
        UserEntity user = users.findById(userId).orElse(null);
        if (user == null) {
            return;
        }
        if (used >= allowance) {
            spent(user, allowance);
            return;
        }
        if (used * 100 >= allowance * LOW_PERCENT) {
            nearlySpent(user, allowance - used, allowance);
        }
    }

    /** The one threshold. Not a series — see {@link #allowance}. */
    static final int LOW_PERCENT = 85;

    private void nearlySpent(UserEntity user, int left, int allowance) {
        if (!user.isAllowanceEmail()) {
            return;
        }
        String subject = count(left, "transcription minute", "transcription minutes") + " left";
        String lead = "You have used " + (allowance - left) + " of your " + allowance
                + " transcription minutes.";
        String act = "There is no reset date and nothing to buy, so the remaining "
                + count(left, "minute", "minutes")
                + " is what the account has. Recallix stops a recording when the balance "
                + "runs out, so it is worth choosing what to record from here.";

        enqueue("allowance-low:" + user.getId(), user, subject, lead, act,
                "Open Recallix", appUrl,
                "You are getting this because allowance warnings are on. It is sent once.",
                MailLifetime.record(Instant.now()));
    }

    private void spent(UserEntity user, int allowance) {
        String subject = "Your transcription allowance is spent";
        String lead = "You have used all " + allowance + " transcription minutes on this account. "
                + "Nothing further can be transcribed.";
        // The words the refusals already use. Somebody who reads this and then
        // meets a refusal in the app should meet the same sentence twice.
        String act = "Your account is open and everything in it stays readable: every meeting, "
                + "every transcript, every summary and every answer you already have is still "
                + "here, and you can still search, export and read all of it.";

        // No switch check. See the class note and V64.
        write("allowance-spent:" + user.getId(), user.getEmail(), user.getId(), subject,
                text(lead, act, "Open Recallix", appUrl),
                html(subject, lead, act, "Open Recallix", appUrl,
                        "This one has no switch: it is a fact about your account, sent once."),
                MailLifetime.record(Instant.now()));

        /*
         * A "you have 15 minutes left" still waiting to go out is now not
         * merely stale, it is false -- and it would arrive after the message
         * that contradicts it. Only a row that has not been delivered is
         * touched; one already sent is history.
         */
        outbox.supersede("allowance-low:" + user.getId(),
                "Superseded by the allowance-spent notice");
    }

    /* ------------------------------------------------------------------ */
    /* 10. Your account was closed and your data deleted                  */
    /* ------------------------------------------------------------------ */

    /**
     * Everything it needs is passed in, because the row it came from is gone.
     *
     * <p>Called from inside {@code closeAccount}'s transaction, after the
     * erasure and before the commit. That ordering is the point: the deletion
     * and the record of it become one commit, so a crash a millisecond later
     * cannot produce an account that was destroyed silently. There is no user
     * row left to look anything up on, no switch to consult and no bell to
     * ring — this is the only channel that still exists, the only record the
     * person keeps, and the only way they would learn of it if it was not them.
     *
     * @param userId  informational; the row it named no longer exists
     * @param address read before the erasure, because it cannot be read after
     */
    public void accountClosed(String userId, String address, long meetingCount, int storedObjects) {
        String subject = "Your Recallix account is closed";
        String lead = "Your account has been closed and its data deleted: "
                + count((int) meetingCount, "meeting", "meetings") + " and "
                + count(storedObjects, "recording", "recordings")
                + ". Nothing is held in a bin and none of it can be recovered.";
        String act = "If you did not do this, somebody had access to your sign-in. There is "
                + "nothing left to recover, but the password on this address is worth changing.";

        write("account-closed:" + userId, address, userId, subject,
                lead + "\n\n" + act + "\n",
                shell(subject,
                        "<p style=\"margin:0 0 16px\">" + escape(lead) + "</p>"
                                + "<p style=\"margin:0\">" + escape(act) + "</p>",
                        null, null,
                        "This is the last message this account will receive."),
                MailLifetime.record(Instant.now()));
    }

    /* ------------------------------- queueing ----------------------------- */

    private void enqueue(String key, UserEntity user, String subject, String lead, String act,
                         String linkLabel, String url, String why, Instant expiresAt) {
        write(key, user.getEmail(), user.getId(), subject,
                text(lead, act, linkLabel, url),
                html(subject, lead, act, linkLabel, url, why), expiresAt);
    }

    /**
     * Write the row, or find that it is already written.
     *
     * <p>No exception on a duplicate, and no check-then-insert either: the
     * insert carries {@code ON CONFLICT DO NOTHING}, so two scheduler instances
     * in the same second produce one row rather than one row and one rolled-back
     * transaction. See {@link MailOutboxRepository#enqueue}.
     *
     * <p>An account with no address is skipped here rather than queued and
     * abandoned later. It is a real state — provisioning never had one to store
     * — and a queue full of rows that were never deliverable is a queue nobody
     * reads.
     */
    private void write(String key, String address, String userId,
                       String subject, String bodyText, String bodyHtml, Instant expiresAt) {
        if (address == null || address.isBlank()) {
            return;
        }
        outbox.enqueue(IdGenerator.mail(), key, address.trim(), subject, bodyText, bodyHtml,
                userId, expiresAt);
    }

    /* ------------------------------- shaping ------------------------------ */

    /** "2 recordings (their notes are kept), and 1 meeting in full". */
    private static String itemised(int recordings, int meetingCount) {
        StringBuilder out = new StringBuilder();
        if (recordings > 0) {
            out.append(count(recordings, "recording", "recordings"))
                    .append(recordings == 1 ? " (its notes are kept)" : " (their notes are kept)");
        }
        if (recordings > 0 && meetingCount > 0) {
            out.append(", and ");
        }
        if (meetingCount > 0) {
            out.append(count(meetingCount, "meeting", "meetings")).append(" in full");
        }
        return out.toString();
    }

    private static String count(int n, String one, String many) {
        return n + " " + (n == 1 ? one : many);
    }

    private static String minutes(int seconds) {
        int m = Math.max(1, Math.round(seconds / 60f));
        return count(m, "minute", "minutes");
    }

    private static String title(Meeting meeting) {
        String t = meeting.getTitle() == null ? "" : meeting.getTitle().strip();
        if (t.isEmpty()) {
            return "Untitled meeting";
        }
        return t.length() <= 120 ? t : t.substring(0, 117) + "...";
    }

    private String settingsUrl() {
        return appUrl + "/settings#data";
    }

    private String meetingUrl(String meetingId) {
        return appUrl + "/meetings/" + meetingId;
    }

    /* ------------------------------ rendering ----------------------------- */

    private static String text(String lead, String act, String linkLabel, String url) {
        return lead + "\n\n" + act + "\n\n" + linkLabel + ": " + url + "\n";
    }

    private String html(String subject, String lead, String act,
                        String linkLabel, String url, String why) {
        return shell(subject,
                "<p style=\"margin:0 0 16px\">" + escape(lead) + "</p>"
                        + "<p style=\"margin:0 0 24px\">" + escape(act) + "</p>",
                linkLabel, url, why);
    }

    /**
     * One frame for all seven, inline-styled because email clients discard a
     * stylesheet.
     *
     * <p>Light rather than the product's near-black. A dark message is rendered
     * on a white background by most clients and on a dark one by a few, and the
     * half that goes wrong is unreadable rather than merely off-brand.
     */
    private String shell(String heading, String body, String linkLabel, String url, String why) {
        String button = linkLabel == null || url == null ? "" :
                "<a href=\"" + url + "\" style=\"display:inline-block;background:#1a1a1a;"
                        + "color:#faf8f5;text-decoration:none;padding:11px 18px;border-radius:6px;"
                        + "font-size:15px\">" + escape(linkLabel) + "</a>";
        return "<!doctype html><html><body style=\"margin:0;padding:24px;background:#faf8f5\">"
                + "<div style=\"max-width:520px;margin:0 auto;background:#fff;border:1px solid #e8e4dc;"
                + "border-radius:10px;padding:28px;font-family:-apple-system,BlinkMacSystemFont,"
                + "'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;font-size:15px;line-height:1.55\">"
                + "<p style=\"margin:0 0 20px;font-size:13px;letter-spacing:.14em;text-transform:uppercase;"
                + "color:#8a8178\">Recallix</p>"
                + "<h1 style=\"margin:0 0 16px;font-size:20px;font-weight:600;line-height:1.3\">"
                + escape(heading) + "</h1>"
                + body + button
                + "<p style=\"margin:24px 0 0;padding-top:16px;border-top:1px solid #e8e4dc;"
                + "font-size:12px;color:#8a8178\">" + escape(why)
                + " Change what Recallix emails you at <a href=\"" + appUrl + "/settings#email\" "
                + "style=\"color:#8a8178\">your settings</a>.</p>"
                + "</div></body></html>";
    }

    /** Titles and task names are user text on their way into markup. */
    private static String escape(String raw) {
        if (raw == null) {
            return "";
        }
        return raw.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;");
    }
}
