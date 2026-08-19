package com.recallix.service;

import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingActionItem;
import com.recallix.entity.UserEntity;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.UserRepository;
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
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The daily reminder digest.
 *
 * <p>Almost every test here asserts that nothing was sent. That is the shape of
 * the risk: this is the only thing in Recallix that contacts somebody without
 * them opening it, so the failures that matter are mailing a person who did not
 * ask, mailing them twice because the process restarted, and mailing them to say
 * they have nothing to do.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class TaskReminderServiceTest {

    private static final String USER = "usr_1";
    private static final LocalDate TODAY = LocalDate.of(2026, 8, 16);

    @Mock private UserRepository users;
    @Mock private MeetingActionItemRepository actionItems;
    @Mock private MeetingRepository meetings;
    @Mock private EmailService email;
    @Mock private AuditService audit;
    @Mock private NotificationService notifications;

    private TaskReminderService service;
    private UserEntity user;
    private final List<MeetingActionItem> due = new ArrayList<>();

    @BeforeEach
    void setUp() {
        service = new TaskReminderService(users, actionItems, meetings, email, audit, notifications,
                "http://localhost:3000/");
        due.clear();

        user = new UserEntity();
        user.setId(USER);
        user.setEmail("ana@example.com");
        user.setTaskReminders(true);

        Meeting meeting = new Meeting();
        meeting.setId("mtg_1");
        meeting.setTitle("Sprint planning");

        when(users.findAwaitingTaskReminder(any())).thenReturn(List.of(user));
        when(meetings.findAllById(any())).thenReturn(List.of(meeting));
        when(actionItems.findDueThrough(anyString(), any())).thenAnswer(inv -> List.copyOf(due));
        when(email.send(anyString(), anyString(), anyString())).thenReturn(true);
    }

    private void task(String title, LocalDate dueOn, String owner) {
        MeetingActionItem a = new MeetingActionItem();
        a.setId("ai_" + due.size());
        a.setMeetingId("mtg_1");
        a.setTitle(title);
        a.setDueOn(dueOn);
        a.setOwnerName(owner);
        a.setStatus("OPEN");
        due.add(a);
    }

    private String bodySent() {
        ArgumentCaptor<String> body = ArgumentCaptor.forClass(String.class);
        verify(email).send(anyString(), anyString(), body.capture());
        return body.getValue();
    }

    private String subjectSent() {
        ArgumentCaptor<String> subject = ArgumentCaptor.forClass(String.class);
        verify(email).send(anyString(), subject.capture(), anyString());
        return subject.getValue();
    }

    @Nested
    class Silence {

        @Test
        @DisplayName("nothing due means no email at all")
        void staysQuietWhenThereIsNothingToSay() {
            // A daily "you have 0 tasks" is how somebody builds a filter rule
            // and stops reading the ones that matter.
            assertThat(service.sendDue(TODAY)).isZero();
            verify(email, never()).send(anyString(), anyString(), anyString());
        }

        @Test
        @DisplayName("a quiet day is not recorded as a send")
        void doesNotStampWhenNothingWasSent() {
            service.sendDue(TODAY);

            // Stamping here would suppress tomorrow's digest, which may have
            // something in it.
            assertThat(user.getTaskReminderSentOn()).isNull();
        }

        @Test
        @DisplayName("a user with no address is skipped, not crashed on")
        void skipsUsersWithNowhereToSend() {
            user.setEmail(null);
            task("Ship it", TODAY, "Priya");

            assertThat(service.sendDue(TODAY)).isZero();
            verify(email, never()).send(anyString(), anyString(), anyString());
        }

        @Test
        @DisplayName("a send that failed is not recorded as one")
        void doesNotStampAFailedSend() {
            when(email.send(anyString(), anyString(), anyString())).thenReturn(false);
            task("Ship it", TODAY, "Priya");

            service.sendDue(TODAY);

            // Leaving it unstamped means an SMTP outage costs a day's digest
            // rather than silently swallowing it forever.
            assertThat(user.getTaskReminderSentOn()).isNull();
            verify(audit, never()).record(anyString(), anyString(), anyString(), anyString());
        }
    }

    @Nested
    class Sending {

        @Test
        @DisplayName("a digest goes out and the day is recorded")
        void sendsAndStamps() {
            task("Ship it", TODAY, "Priya");

            assertThat(service.sendDue(TODAY)).isEqualTo(1);
            assertThat(user.getTaskReminderSentOn()).isEqualTo(TODAY);
        }

        @Test
        @DisplayName("the subject leads with what is already late")
        void overdueLeadsTheSubject() {
            task("Ship it", TODAY, "Priya");
            task("Finish the migration", TODAY.minusDays(4), "Priya");

            // "2 tasks this week" and "1 task is overdue" are different
            // messages, and the subject is the part most people read.
            assertThat(subjectSentAfter()).isEqualTo("1 action item is overdue");
        }

        @Test
        @DisplayName("with nothing late, the subject says what is due today")
        void todayLeadsWhenNothingIsLate() {
            task("Ship it", TODAY, "Priya");

            assertThat(subjectSentAfter()).isEqualTo("1 action item is due today");
        }

        @Test
        @DisplayName("with nothing late or due, it says what is coming")
        void otherwiseItIsAHeadsUp() {
            task("Ship it", TODAY.plusDays(2), "Priya");

            assertThat(subjectSentAfter()).isEqualTo("1 action item due soon");
        }

        @Test
        @DisplayName("the body groups by urgency rather than listing everything flat")
        void groupsByUrgency() {
            task("Finish the migration", TODAY.minusDays(4), "Priya");
            task("Ship it", TODAY, "Marcus");
            task("Book the room", TODAY.plusDays(2), null);

            String body = bodySentAfter();
            assertThat(body).contains("OVERDUE (1)", "DUE TODAY (1)", "COMING UP (1)");
            assertThat(body.indexOf("OVERDUE")).isLessThan(body.indexOf("COMING UP"));
        }

        @Test
        @DisplayName("each line says how late it is, not just when it was due")
        void spellsOutLateness() {
            task("Finish the migration", TODAY.minusDays(4), "Priya");

            // "due 12 Aug" makes the reader do the arithmetic that decides
            // whether they care.
            assertThat(bodySentAfter()).contains("4 days late");
        }

        @Test
        @DisplayName("each line says whose it is and which meeting it came from")
        void namesTheOwnerAndTheMeeting() {
            task("Finish the migration", TODAY.minusDays(1), "Priya");

            assertThat(bodySentAfter()).contains("Priya").contains("Sprint planning");
        }

        @Test
        @DisplayName("the digest links back and says how to turn itself off")
        void isUnsubscribable() {
            task("Ship it", TODAY, "Priya");

            String body = bodySentAfter();
            assertThat(body).contains("http://localhost:3000/action-items");
            assertThat(body).contains("Settings");
        }

        @Test
        @DisplayName("a long list is truncated rather than mailed in full")
        void truncates() {
            for (int i = 0; i < 40; i++) {
                task("Task " + i, TODAY, "Priya");
            }

            assertThat(bodySentAfter()).contains("and 15 more");
        }
    }

    /**
     * Cadence and the master switch (V40).
     *
     * <p>A weekly digest is the same message on one day in seven, so the tests
     * are the two days: Monday sends, anything else does not. The dates are
     * spelled out rather than derived, because a cadence test that computes its
     * own weekday can agree with a bug.
     */
    @Nested
    @DisplayName("cadence")
    class Cadence {

        private static final LocalDate MONDAY = LocalDate.of(2026, 8, 17);
        private static final LocalDate SUNDAY = LocalDate.of(2026, 8, 16);

        @Test
        @DisplayName("a weekly digest waits for Monday")
        void weeklyIsSilentMidweek() {
            onlyWeekly();
            task("Ship the thing", SUNDAY, "Priya");

            assertThat(service.sendDue(SUNDAY)).isZero();
            verify(email, never()).send(anyString(), anyString(), anyString());
        }

        @Test
        @DisplayName("a weekly digest goes out on Monday")
        void weeklyArrivesOnMonday() {
            onlyWeekly();
            task("Ship the thing", MONDAY, "Priya");

            assertThat(service.sendDue(MONDAY)).isEqualTo(1);
        }

        @Test
        @DisplayName("both switches on a Monday send one message, not two")
        void mondayWithBothSendsOnce() {
            // The failure this guards against is not a missing email, it is two
            // of them a minute apart drawn from overlapping lists — which reads
            // as a bug rather than as two features working (V43).
            user.setWeeklyDigest(true);
            task("Ship the thing", MONDAY, "Priya");

            assertThat(service.sendDue(MONDAY)).isEqualTo(1);
            verify(email).send(anyString(), anyString(), anyString());
        }

        @Test
        @DisplayName("the Monday message says it is the weekly one")
        void mondayNamesTheRightSwitch() {
            onlyWeekly();
            task("Ship the thing", MONDAY, "Priya");
            service.sendDue(MONDAY);

            // The footer sends people to the switch that sent it. Naming the
            // other one would send them to turn off the mail they kept.
            assertThat(bodySent()).contains("\"Weekly digest\"").doesNotContain("\"Event reminder\"");
        }

        @Test
        @DisplayName("the daily message says it is the daily one")
        void dailyNamesTheRightSwitch() {
            task("Ship the thing", SUNDAY, "Priya");
            service.sendDue(SUNDAY);

            assertThat(bodySent()).contains("\"Event reminder\"").doesNotContain("\"Weekly digest\"");
        }

        @Test
        @DisplayName("the Monday review looks a full week ahead, where the daily one does not")
        void weeklyReachesFurther() {
            // Five days out: past the daily horizon of three, inside the week.
            onlyWeekly();
            task("Ship the thing", MONDAY.plusDays(5), "Priya");

            assertThat(service.sendDue(MONDAY)).isEqualTo(1);

            // The same item, the same day, on the daily switch: out of range,
            // so nothing is owed and nothing is sent.
            reset(email);
            user.setWeeklyDigest(false);
            user.setTaskReminders(true);
            user.setTaskReminderSentOn(null);
            assertThat(service.sendDue(MONDAY)).isZero();
        }

        @Test
        @DisplayName("a week with nothing due is silent, the same as a day with nothing due")
        void anEmptyWeekSaysNothing() {
            onlyWeekly();

            assertThat(service.sendDue(MONDAY)).isZero();
            verify(email, never()).send(anyString(), anyString(), anyString());
        }

        /** The Monday review alone — the daily switch off, as V43 migrates it. */
        private void onlyWeekly() {
            user.setTaskReminders(false);
            user.setWeeklyDigest(true);
        }

        @Test
        @DisplayName("a daily digest is unaffected by the day of the week")
        void dailyIgnoresTheCalendar() {
            task("Ship the thing", SUNDAY, "Priya");

            assertThat(service.sendDue(SUNDAY)).isEqualTo(1);
        }

        @Test
        @DisplayName("the master switch silences the digest without forgetting it was wanted")
        void masterSwitchSilencesTheDigest() {
            user.setEmailsEnabled(false);
            task("Ship the thing", MONDAY, "Priya");

            assertThat(service.sendDue(MONDAY)).isZero();
            verify(email, never()).send(anyString(), anyString(), anyString());
            // Checked at send time, so the preference survives to be honoured
            // again the moment the master goes back on.
            assertThat(user.isTaskReminders()).isTrue();
        }
    }

    /** Runs the digest, then reads the subject it sent. */
    private String subjectSentAfter() {
        service.sendDue(TODAY);
        return subjectSent();
    }

    private String bodySentAfter() {
        service.sendDue(TODAY);
        return bodySent();
    }
}
