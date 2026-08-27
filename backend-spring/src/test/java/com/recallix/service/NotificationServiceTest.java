package com.recallix.service;

import com.recallix.domain.NotificationKind;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingActionItem;
import com.recallix.entity.Notification;
import com.recallix.entity.UserEntity;
import com.recallix.repository.NotificationRepository;
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
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * What Recallix says, and what it has the sense not to.
 *
 * <p>A notification system fails in one direction far more often than the
 * other: it says too much, somebody stops looking at the bell, and then the one
 * that mattered — the upload that failed overnight — is unread among forty that
 * did not. So most of these tests are about silence. Muted kinds are never
 * written rather than hidden on read; a thing already said today is not said
 * again; a count of zero produces nothing at all.
 *
 * <p>The rest are about not being a liability. A notification is commentary on
 * work that already succeeded, so nothing here may throw at the thing it is
 * commenting on, and the browser is not told to re-read until the row it would
 * read is actually committed.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class NotificationServiceTest {

    private static final String USER = "usr_1";
    private static final LocalDate TODAY = LocalDate.of(2026, 8, 16);

    @Mock private NotificationRepository notifications;
    @Mock private UserRepository users;
    @Mock private NotificationPublisher publisher;

    private NotificationService service;
    private UserEntity user;

    @BeforeEach
    void setUp() {
        service = new NotificationService(notifications, users, publisher);
        user = new UserEntity();
        user.setId(USER);
        user.setMutedNotifications(new ArrayList<>());
        when(users.findById(USER)).thenReturn(Optional.of(user));
        when(notifications.save(any(Notification.class))).thenAnswer(i -> i.getArgument(0));
    }

    /** The notification that was written. Fails the test if none was. */
    private Notification written() {
        ArgumentCaptor<Notification> captor = ArgumentCaptor.forClass(Notification.class);
        verify(notifications, atLeastOnce()).save(captor.capture());
        return captor.getValue();
    }

    private static Meeting meeting() {
        Meeting m = new Meeting();
        m.setId("mtg_1");
        m.setUserId(USER);
        m.setTitle("Sprint planning");
        return m;
    }

    /* -------------------------------- silence ------------------------------ */

    @Nested
    @DisplayName("not saying things")
    class Silence {

        @Test
        void neverWritesAKindThatWasSwitchedOff() {
            user.setMutedNotifications(new ArrayList<>(List.of("SUMMARY_READY")));

            service.summaryReady(meeting(), 1);

            // Not written rather than hidden on read: filtering at render time
            // means switching a kind back on floods the bell with a month of
            // things somebody had already decided they did not want.
            verify(notifications, never()).save(any());
        }

        @Test
        void refusesToLetAFailureBeSwitchedOff() {
            user.setMutedNotifications(new ArrayList<>(List.of("PROCESSING_FAILED")));

            service.processingFailed(meeting(), "the audio was unreadable", 1);

            // Muting this one turns "nothing happened" and "something went
            // wrong" into the same silence, which is the state the whole
            // feature exists to end.
            assertThat(written()).isNotNull();
        }

        @Test
        void saysNothingTwiceInADay() {
            when(notifications.existsByUserIdAndKindAndDedupeKey(
                    USER, NotificationKind.RETENTION_APPLIED, "day:" + TODAY)).thenReturn(true);

            service.retentionApplied(USER, 3, 0, TODAY);

            verify(notifications, never()).save(any());
        }

        @Test
        void saysNothingWhenNothingHappened() {
            service.retentionApplied(USER, 0, 0, TODAY);

            // "Retention deleted 0 items" every night is how a daily
            // notification becomes a filter rule.
            verify(notifications, never()).save(any());
        }

        @Test
        void saysNothingAboutAMeetingThatNamedNobody() {
            service.mentionedIn(meeting(), List.of());

            verify(notifications, never()).save(any());
        }

        @Test
        void ignoresARequestWithNoUser() {
            Meeting orphan = meeting();
            orphan.setUserId("");

            service.summaryReady(orphan, 1);

            verify(notifications, never()).save(any());
        }
    }

    /* -------------------------------- wording ------------------------------ */

    @Nested
    @DisplayName("what it says")
    class Wording {

        @Test
        void namesTheMeetingRatherThanTheEvent() {
            service.summaryReady(meeting(), 1);

            // "Sprint planning" is what somebody scanning a list recognises;
            // "Summary ready" is the same sentence on every row.
            Notification n = written();
            assertThat(n.getTitle()).isEqualTo("Sprint planning");
            assertThat(n.getBody()).contains("notes are written");
            assertThat(n.getLink()).isEqualTo("/meetings/mtg_1");
        }

        @Test
        void saysWhatWentWrongWhenSomethingDid() {
            service.processingFailed(meeting(), "the audio was unreadable", 1);

            assertThat(written().getBody())
                    .contains("the audio was unreadable")
                    .contains("try again");
        }

        @Test
        void survivesAFailureWithNoExplanation() {
            service.processingFailed(meeting(), null, 1);

            assertThat(written().getBody()).startsWith("Processing failed.");
        }

        @Test
        void namesTheWorkItGaveYou() {
            service.mentionedIn(meeting(), List.of(task("Finish the JWT validation")));

            Notification n = written();
            assertThat(n.getTitle()).isEqualTo("You were given an action item");
            assertThat(n.getBody()).contains("Finish the JWT validation").contains("Sprint planning");
            assertThat(n.getLink()).endsWith("?tab=actions");
        }

        @Test
        void countsTheWorkRatherThanListingAllOfIt() {
            service.mentionedIn(meeting(), List.of(task("One"), task("Two"), task("Three"), task("Four")));

            Notification n = written();
            assertThat(n.getTitle()).isEqualTo("You were given 4 action items");
            assertThat(n.getBody()).contains("One; Two and 2 more");
        }

        @Test
        void countsWhatWentRatherThanNamingIt() {
            service.retentionApplied(USER, 3, 0, TODAY);

            // Deliberately not a list: a bell that has to be read is a bell
            // nobody glances at.
            assertThat(written().getTitle()).isEqualTo("Retention deleted 3 items");
        }

        @Test
        void putsAMeetingWithNoNameUnderOne() {
            Meeting untitled = meeting();
            untitled.setTitle("   ");

            service.summaryReady(untitled, 1);

            assertThat(written().getTitle()).isEqualTo("Untitled meeting");
        }

        @Test
        void saysNothingAtAllWhenAMeetingStartsProcessing() {
            // "Processing started -- we'll tell you when the notes are ready"
            // spent a row of the bell, on every meeting, promising the row that
            // follows it. Pressing Save already puts the meeting in the list
            // with its own stage and its own bar; the reader is looking at it.
            //
            // Asserted here as the absence of a method rather than of a call,
            // which is the strongest form this can take: there is nothing left
            // to invoke. The same went for "Recording started", which announced
            // a microphone that is running on the screen in front of you.
            assertThat(NotificationKind.RECORDING_STARTED.retired()).isTrue();
            assertThat(NotificationKind.PROCESSING_STARTED.retired()).isTrue();
        }

        @Test
        void keepsRetiredKindsAroundSoOldRowsStillMap() {
            // The kind is stored as its name. Deleting the constant would stop
            // every notification already written with one of these from
            // mapping, and take the whole list down with it.
            assertThat(NotificationKind.find("RECORDING_STARTED")).isPresent();
            assertThat(NotificationKind.find("PROCESSING_STARTED")).isPresent();
        }

        @Test
        void offersNoSwitchForSomethingThatCannotHappen() {
            // A control over an event nothing emits implies the opposite state
            // is reachable.
            assertThat(NotificationKind.active())
                    .doesNotContain(NotificationKind.RECORDING_STARTED,
                            NotificationKind.PROCESSING_STARTED)
                    .contains(NotificationKind.SUMMARY_READY,
                            NotificationKind.PROCESSING_FAILED,
                            NotificationKind.MENTIONED_IN_MEETING);
        }
    }

    /* ------------------------------- the bell ------------------------------ */

    @Nested
    @DisplayName("the badge")
    class Badge {

        @Test
        void tellsTheBrowserSomethingChanged() {
            when(notifications.countByUserIdAndReadAtIsNull(USER)).thenReturn(4L);

            service.summaryReady(meeting(), 1);

            // Only a count. The topic is unauthenticated, so the content stays
            // on the REST side where the caller is actually checked.
            verify(publisher).ping(USER, 4L);
        }

        @Test
        void saysNothingToTheBrowserWhenNothingWasWritten() {
            user.setMutedNotifications(new ArrayList<>(List.of("SUMMARY_READY")));

            service.summaryReady(meeting(), 1);

            verify(publisher, never()).ping(anyString(), anyLong());
        }
    }

    /* ------------------------------ not a liability ------------------------ */

    @Nested
    @DisplayName("staying out of the way")
    class Harmless {

        @Test
        void doesNotFailTheWorkItIsReportingOn() {
            when(notifications.save(any(Notification.class)))
                    .thenThrow(new RuntimeException("the database is on fire"));

            // A meeting that processed correctly must not be reported as failed
            // because the sentence about it could not be written down.
            assertThatCode(() -> service.summaryReady(meeting(), 1)).doesNotThrowAnyException();
        }

        @Test
        void survivesAUserRowThatIsNotThere() {
            when(users.findById(USER)).thenReturn(Optional.empty());

            service.summaryReady(meeting(), 1);

            // No preferences to read is not the same as everything muted.
            assertThat(written()).isNotNull();
        }
    }

    /* -------------------------------- reading ------------------------------ */

    @Nested
    @DisplayName("reading and clearing")
    class Reading {

        @Test
        void marksOneRead() {
            Notification n = new Notification();
            n.setId("ntf_1");
            n.setUserId(USER);
            n.setKind(NotificationKind.SUMMARY_READY);
            n.setTitle("Sprint planning");
            when(notifications.findByIdAndUserId("ntf_1", USER)).thenReturn(Optional.of(n));

            assertThat(service.markRead(USER, "ntf_1", true).read()).isTrue();
            assertThat(n.getReadAt()).isNotNull();
        }

        @Test
        void putsOneBackToUnread() {
            Notification n = new Notification();
            n.setId("ntf_1");
            n.setUserId(USER);
            n.setKind(NotificationKind.SUMMARY_READY);
            n.setTitle("Sprint planning");
            n.setReadAt(java.time.Instant.now());
            when(notifications.findByIdAndUserId("ntf_1", USER)).thenReturn(Optional.of(n));

            // Opening the bell marks things read on sight; putting one back is
            // how somebody keeps a reminder they cannot act on yet.
            assertThat(service.markRead(USER, "ntf_1", false).read()).isFalse();
        }

        @Test
        void refusesToTouchSomebodyElses() {
            when(notifications.findByIdAndUserId("ntf_1", "usr_2")).thenReturn(Optional.empty());

            assertThatCode(() -> service.markRead("usr_2", "ntf_1", true))
                    .isInstanceOf(com.recallix.common.ApiException.class);
        }

        @Test
        void deletingSomebodyElsesDoesNothingRatherThanFailing() {
            when(notifications.findByIdAndUserId("ntf_1", "usr_2")).thenReturn(Optional.empty());

            service.delete("usr_2", "ntf_1");

            verify(notifications, never()).delete(any());
        }

        @Test
        void clearsTheLot() {
            when(notifications.deleteAllForUser(USER)).thenReturn(12);

            assertThat(service.clear(USER)).isEqualTo(12);
        }
    }

    private static MeetingActionItem task(String title) {
        MeetingActionItem a = new MeetingActionItem();
        a.setId("ai_" + title.hashCode());
        a.setMeetingId("mtg_1");
        a.setTitle(title);
        a.setOwnerName("Priya");
        a.setStatus("OPEN");
        return a;
    }
}
