package com.orion.service;

import com.orion.entity.Meeting;
import com.orion.entity.MeetingActionItem;
import com.orion.entity.UserEntity;
import com.orion.repository.MailOutboxRepository;
import com.orion.repository.MeetingRepository;
import com.orion.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

/**
 * What gets queued, keyed how, and said in what words.
 *
 * <h2>Note what these assert about, and what they deliberately do not</h2>
 *
 * <p>Nothing here sends anything, because {@link AccountMail} does not send
 * anything. It writes a row and returns. That separation is the fix the audit
 * asked for: the previous version tried to deliver inline, so a ninety-second
 * Resend outage during the retention pass permanently lost the only notice an
 * account holder got that their data had been deleted.
 *
 * <p>So what matters here is the <b>dedupe key</b>. It is the idempotency of the
 * whole system in one string: it stops a second scheduler instance queueing a
 * duplicate, it replaces the five "already sent" stamp columns an earlier draft
 * had, and it travels to the provider so a retry after a lost acknowledgement is
 * not delivered twice. Delivery itself is {@link MailDispatcherTest}'s subject.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class AccountMailTest {

    private static final String USER = "usr_1";
    private static final LocalDate TODAY = LocalDate.of(2026, 3, 5);

    @Mock private MailOutboxRepository outbox;
    @Mock private UserRepository users;
    @Mock private MeetingRepository meetings;

    private AccountMail mail;
    private UserEntity user;

    @BeforeEach
    void setUp() {
        mail = new AccountMail(outbox, users, meetings, "https://recallix.test", 900);
        user = new UserEntity();
        user.setId(USER);
        user.setEmail("ada@example.com");
        org.mockito.Mockito.when(users.findById(USER)).thenReturn(Optional.of(user));
    }

    private record Queued(String key, String to, String subject, String text, String html) {}

    /** The one row that was written. */
    private Queued queued() {
        ArgumentCaptor<String> key = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> to = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> subject = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> text = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> html = ArgumentCaptor.forClass(String.class);
        verify(outbox).enqueue(anyString(), key.capture(), to.capture(), subject.capture(),
                text.capture(), html.capture(), any(), any());
        return new Queued(key.getValue(), to.getValue(), subject.getValue(),
                text.getValue(), html.getValue());
    }

    private void nothingQueued() {
        verify(outbox, never()).enqueue(anyString(), anyString(), anyString(), anyString(),
                anyString(), anyString(), any(), any());
    }

    @Nested
    @DisplayName("the retention warning")
    class Warning {

        private final RetentionService.Due due = new RetentionService.Due(2, 1);
        private final LocalDate deletesOn = LocalDate.of(2026, 3, 12);

        @BeforeEach
        void on() {
            user.setRetentionWarningEmail(true);
        }

        @Test
        @DisplayName("is keyed to the day the deletion lands, not the day it was written")
        void keyedToTheEvent() {
            /*
             * THE correction. Keyed to the send day -- "one warning a week" --
             * a batch crossing the horizon on Tuesday is suppressed for six
             * days and then deleted, unwarned. Keyed to the event, every batch
             * has its own identity.
             */
            mail.retentionWarning(user, deletesOn, due);

            assertThat(queued().key()).isEqualTo("retention-warning:usr_1:2026-03-12");
        }

        @Test
        @DisplayName("names the day, because now it is one day")
        void namesTheDay() {
            mail.retentionWarning(user, deletesOn, due);

            Queued q = queued();
            assertThat(q.subject()).contains("3 items").contains("12 March 2026");
            assertThat(q.text())
                    .contains("2 recordings (their notes are kept)")
                    .contains("1 meeting in full")
                    .contains("cannot be undone")
                    .contains("https://recallix.test/settings#data");
        }

        @Test
        @DisplayName("gives two different batches two different keys")
        void twoBatches() {
            // A day apart, two deletions, two warnings. The old rule sent one.
            mail.retentionWarning(user, deletesOn, new RetentionService.Due(1, 0));
            mail.retentionWarning(user, deletesOn.plusDays(1), new RetentionService.Due(0, 1));

            ArgumentCaptor<String> keys = ArgumentCaptor.forClass(String.class);
            verify(outbox, org.mockito.Mockito.times(2)).enqueue(anyString(), keys.capture(),
                    anyString(), anyString(), anyString(), anyString(), any(), any());
            assertThat(keys.getAllValues()).containsExactly(
                    "retention-warning:usr_1:2026-03-12",
                    "retention-warning:usr_1:2026-03-13");
        }

        @Test
        @DisplayName("gives the same batch the same key however often it is asked")
        void sameBatch() {
            // The row is unique on this key and enqueue is ON CONFLICT DO
            // NOTHING, so identical keys is identical to "mailed once".
            mail.retentionWarning(user, deletesOn, due);
            mail.retentionWarning(user, deletesOn, due);
            mail.retentionWarning(user, deletesOn, due);

            ArgumentCaptor<String> keys = ArgumentCaptor.forClass(String.class);
            verify(outbox, org.mockito.Mockito.times(3)).enqueue(anyString(), keys.capture(),
                    anyString(), anyString(), anyString(), anyString(), any(), any());
            assertThat(keys.getAllValues()).containsOnly("retention-warning:usr_1:2026-03-12");
        }

        @Test
        @DisplayName("stays silent when nothing is due or the switch is off")
        void silent() {
            mail.retentionWarning(user, deletesOn, new RetentionService.Due(0, 0));
            user.setRetentionWarningEmail(false);
            mail.retentionWarning(user, deletesOn, due);

            nothingQueued();
        }
    }

    @Nested
    @DisplayName("the retention digest")
    class Applied {

        @BeforeEach
        void on() {
            user.setRetentionAppliedEmail(true);
        }

        @Test
        @DisplayName("is one row for the night's work")
        void keyedToTheNight() {
            mail.retentionApplied(USER, 2, 1, TODAY);

            Queued q = queued();
            assertThat(q.key()).isEqualTo("retention-applied:usr_1:2026-03-05");
            assertThat(q.text()).contains("cannot be undone");
        }

        @Test
        @DisplayName("is a different row the next night, because that is different work")
        void tomorrowIsNew() {
            mail.retentionApplied(USER, 1, 0, TODAY);
            mail.retentionApplied(USER, 1, 0, TODAY.plusDays(1));

            ArgumentCaptor<String> keys = ArgumentCaptor.forClass(String.class);
            verify(outbox, org.mockito.Mockito.times(2)).enqueue(anyString(), keys.capture(),
                    anyString(), anyString(), anyString(), anyString(), any(), any());
            assertThat(keys.getAllValues()).containsExactly(
                    "retention-applied:usr_1:2026-03-05", "retention-applied:usr_1:2026-03-06");
        }

        @Test
        @DisplayName("says nothing when the pass deleted nothing")
        void quiet() {
            mail.retentionApplied(USER, 0, 0, TODAY);

            nothingQueued();
            // And does not even look the account up.
            verifyNoInteractions(users);
        }
    }

    @Nested
    @DisplayName("the deadline digest")
    class Reminder {

        @BeforeEach
        void on() {
            user.setTaskReminderEmail(true);
        }

        private MeetingActionItem item(String title, LocalDate due) {
            MeetingActionItem a = new MeetingActionItem();
            a.setId("act_" + title);
            a.setMeetingId("mtg_1");
            a.setUserId(USER);
            a.setTitle(title);
            a.setDueOn(due);
            return a;
        }

        @Test
        @DisplayName("counts what is late separately from what is merely due")
        void split() {
            mail.taskReminder(USER, List.of(
                    item("Send the contract", TODAY.minusDays(3)),
                    item("Ship the export work", TODAY.plusDays(1))), TODAY);

            Queued q = queued();
            assertThat(q.subject()).isEqualTo("1 task overdue, 1 due");
            assertThat(q.key()).isEqualTo("task-reminder:usr_1:2026-03-05");
        }

        @Test
        @DisplayName("links each task to the meeting it was agreed in")
        void linked() {
            mail.taskReminder(USER, List.of(item("Send the contract", TODAY)), TODAY);

            assertThat(queued().text()).contains("https://recallix.test/meetings/mtg_1");
        }

        @Test
        @DisplayName("has no empty edition")
        void neverEmpty() {
            mail.taskReminder(USER, List.of(), TODAY);

            nothingQueued();
        }

        @Test
        @DisplayName("escapes a task somebody typed, since it goes into markup")
        void escapes() {
            mail.taskReminder(USER, List.of(item("Fix <script> handling", TODAY)), TODAY);

            assertThat(queued().html()).contains("&lt;script&gt;").doesNotContain("<script>");
        }
    }

    @Nested
    @DisplayName("notes ready")
    class Notes {

        private Meeting meeting;

        @BeforeEach
        void on() {
            user.setNotesReadyEmail(true);
            meeting = new Meeting();
            meeting.setId("mtg_9");
            meeting.setUserId(USER);
            meeting.setTitle("Quarterly review");
            meeting.setDurationSeconds(5400);
            org.mockito.Mockito.when(meetings.findById("mtg_9")).thenReturn(Optional.of(meeting));
        }

        @Test
        @DisplayName("is keyed to the meeting, so a reprocess re-queues nothing")
        void keyedToTheMeeting() {
            // Kafka delivery is at-least-once and a reprocess raises every
            // effect again with a higher attempt number. Both converge here.
            mail.notesReady("mtg_9");
            mail.notesReady("mtg_9");

            ArgumentCaptor<String> keys = ArgumentCaptor.forClass(String.class);
            verify(outbox, org.mockito.Mockito.times(2)).enqueue(anyString(), keys.capture(),
                    anyString(), anyString(), anyString(), anyString(), any(), any());
            assertThat(keys.getAllValues()).containsOnly("notes-ready:mtg_9");
        }

        @Test
        @DisplayName("goes for a long recording")
        void longOne() {
            mail.notesReady("mtg_9");

            Queued q = queued();
            assertThat(q.subject()).contains("Quarterly review");
            assertThat(q.text()).contains("90 minutes");
        }

        @Test
        @DisplayName("never goes for a short one, or one of unknown length")
        void shortOne() {
            // Fails closed on null: the threshold is the whole justification
            // for this message and an unknown length cannot clear it.
            meeting.setDurationSeconds(30);
            mail.notesReady("mtg_9");
            meeting.setDurationSeconds(null);
            mail.notesReady("mtg_9");

            nothingQueued();
        }
    }

    @Nested
    @DisplayName("the allowance")
    class Allowance {

        @BeforeEach
        void on() {
            user.setAllowanceEmail(true);
        }

        @Test
        @DisplayName("warns once, at the threshold, on a once-ever key")
        void nearly() {
            mail.allowance(USER, 85, 100);

            Queued q = queued();
            assertThat(q.key()).isEqualTo("allowance-low:usr_1");
            assertThat(q.subject()).isEqualTo("15 transcription minutes left");
            assertThat(q.text()).contains("nothing to buy");
        }

        @Test
        @DisplayName("is silent below it")
        void below() {
            mail.allowance(USER, 84, 100);

            nothingQueued();
        }

        @Test
        @DisplayName("is never a series")
        void notASeries() {
            // Every minute after the threshold crosses it again. One key.
            mail.allowance(USER, 85, 100);
            mail.allowance(USER, 90, 100);
            mail.allowance(USER, 99, 100);

            ArgumentCaptor<String> keys = ArgumentCaptor.forClass(String.class);
            verify(outbox, org.mockito.Mockito.times(3)).enqueue(anyString(), keys.capture(),
                    anyString(), anyString(), anyString(), anyString(), any(), any());
            assertThat(keys.getAllValues()).containsOnly("allowance-low:usr_1");
        }

        @Test
        @DisplayName("says what is kept when the allowance is spent")
        void spent() {
            /*
             * "You're out" reads as "your account is closed" unless the message
             * says otherwise. This is the sentence that stops somebody assuming
             * their meetings went with their minutes.
             */
            mail.allowance(USER, 100, 100);

            Queued q = queued();
            assertThat(q.key()).isEqualTo("allowance-spent:usr_1");
            assertThat(q.subject()).isEqualTo("Your transcription allowance is spent");
            assertThat(q.text()).contains("Your account is open").contains("still here");
        }

        @Test
        @DisplayName("queues the spent notice even with the switch off")
        void spentHasNoSwitch() {
            // A fact about the account rather than a report on its contents.
            // Somebody who never sees it concludes the product broke.
            user.setAllowanceEmail(false);

            mail.allowance(USER, 100, 100);

            assertThat(queued().key()).isEqualTo("allowance-spent:usr_1");
        }

        @Test
        @DisplayName("does not also warn about being nearly out once it is out")
        void notBoth() {
            mail.allowance(USER, 100, 100);

            assertThat(queued().key()).isEqualTo("allowance-spent:usr_1");
        }
    }

    @Nested
    @DisplayName("the account being closed")
    class Closed {

        @Test
        @DisplayName("needs nothing from the database, because there is nothing left")
        void noLookup() {
            /*
             * The proof that the payload has to be captured rather than looked
             * up. This runs inside the transaction that deleted the user row:
             * the address, the counts and the switches are already gone.
             */
            mail.accountClosed(USER, "ada@example.com", 12, 9);

            Queued q = queued();
            assertThat(q.key()).isEqualTo("account-closed:usr_1");
            assertThat(q.to()).isEqualTo("ada@example.com");
            assertThat(q.text()).contains("12 meetings").contains("9 recordings")
                    .contains("If you did not do this");
            verifyNoInteractions(users);
            verifyNoInteractions(meetings);
        }

        @Test
        @DisplayName("has no switch to consult, and consults none")
        void noSwitch() {
            // Every switch on this account is false; the message goes anyway.
            mail.accountClosed(USER, "ada@example.com", 1, 0);

            assertThat(queued().key()).isEqualTo("account-closed:usr_1");
        }

        @Test
        @DisplayName("queues nothing for an account that never had an address")
        void noAddress() {
            // A real state -- provisioning never had one to store. Queueing it
            // would put a row in that could never be delivered.
            mail.accountClosed(USER, null, 1, 0);
            mail.accountClosed(USER, "  ", 1, 0);

            nothingQueued();
        }

        @Test
        @DisplayName("is the same row on a retry, not a second one")
        void onceEver() {
            mail.accountClosed(USER, "ada@example.com", 12, 9);
            mail.accountClosed(USER, "ada@example.com", 12, 9);

            ArgumentCaptor<String> keys = ArgumentCaptor.forClass(String.class);
            verify(outbox, org.mockito.Mockito.times(2)).enqueue(anyString(), keys.capture(),
                    anyString(), anyString(), anyString(), anyString(), eq(USER), any());
            assertThat(keys.getAllValues()).containsOnly("account-closed:usr_1");
        }
    }

    /**
     * What a queued row is allowed to hold.
     *
     * <p>{@code mail_outbox} has no foreign key to anything and outlives the
     * account it belongs to — the closure notice is delivered after
     * {@code closeAccount} has erased everything else. It is one of the very few
     * places in Recallix where personal data survives erasure, so what goes into
     * it is a decision and these assertions are the record of it.
     */
    @Nested
    @DisplayName("what the payload may contain")
    class Payload {

        @Test
        @DisplayName("a digest carries the task and its date, and nothing that was said")
        void nothingFromTheRoom() {
            /*
             * sourceSentence is the quoted line the task was extracted from --
             * somebody's actual words in an actual meeting. It is exactly the
             * kind of thing that makes a digest read better and must not be
             * copied into a table that survives account deletion. Same for the
             * speaker it was attributed to.
             */
            user.setTaskReminderEmail(true);
            MeetingActionItem item = new MeetingActionItem();
            item.setId("act_1");
            item.setMeetingId("mtg_1");
            item.setUserId(USER);
            item.setTitle("Send the contract");
            item.setDueOn(TODAY);
            item.setOwnerName("Priya Raman");
            item.setSourceSentence("Priya said she would get the contract over to legal by Friday");

            mail.taskReminder(USER, List.of(item), TODAY);

            Queued q = queued();
            String everything = q.subject() + q.text() + q.html();
            assertThat(everything).contains("Send the contract");
            assertThat(everything).doesNotContain("get the contract over to legal");
            assertThat(everything).doesNotContain("Priya Raman");
        }

        @Test
        @DisplayName("a notes-ready message names the meeting and links to it, and quotes none of it")
        void noExcerpt() {
            // The link carries an id. The app stays the place the content lives.
            user.setNotesReadyEmail(true);
            Meeting m = new Meeting();
            m.setId("mtg_9");
            m.setUserId(USER);
            m.setTitle("Quarterly review");
            m.setDurationSeconds(5400);
            org.mockito.Mockito.when(meetings.findById("mtg_9")).thenReturn(Optional.of(m));

            mail.notesReady("mtg_9");

            Queued q = queued();
            assertThat(q.subject()).contains("Quarterly review");
            assertThat(q.text()).contains("https://recallix.test/meetings/mtg_9");
            // Length is the cheap proxy: a body carrying an excerpt would not
            // fit in the two sentences these messages are.
            assertThat(q.text().length()).isLessThan(600);
        }
    }
}
