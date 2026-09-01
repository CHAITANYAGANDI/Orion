package com.reverie.service;

import com.reverie.common.ApiException;
import com.reverie.entity.Meeting;
import com.reverie.entity.UserEntity;
import com.reverie.repository.MeetingRepository;
import com.reverie.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * A rule set once that deletes things for years afterwards.
 *
 * <p>Which makes it the most dangerous thing in the product and the one place
 * where "roughly right" is not good enough. The tests below are mostly about the
 * boundary — a meeting exactly at the cut-off, a meeting a day inside it — and
 * about the two ways a two-dial policy can quietly betray the person who set it:
 * by deleting the meeting before the narrower rule protecting its audio ever
 * runs, and by reporting one deletion as two.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class RetentionServiceTest {

    private static final String USER = "usr_1";
    private static final LocalDate TODAY = LocalDate.of(2026, 8, 16);

    @Mock private UserRepository users;
    @Mock private MeetingRepository meetings;
    @Mock private ErasureService erasure;
    @Mock private NotificationService notifications;
    @Mock private AuditService audit;
    @Mock private AccountMail mail;

    private RetentionService service;
    private UserEntity user;

    @BeforeEach
    void setUp() {
        service = new RetentionService(users, meetings, erasure, notifications, audit, mail);
        user = new UserEntity();
        user.setId(USER);
        when(users.findById(USER)).thenReturn(Optional.of(user));
    }

    /** A meeting created {@code daysAgo} days before TODAY, at midday UTC. */
    private static Meeting aged(String id, int daysAgo) {
        Meeting meeting = new Meeting();
        meeting.setId(id);
        meeting.setUserId(USER);
        meeting.setTitle(id);
        meeting.setObjectKey("meetings/usr_1/" + id + "/audio.mp3");
        meeting.setCreatedAt(TODAY.minusDays(daysAgo).atTime(12, 0).toInstant(ZoneOffset.UTC));
        return meeting;
    }

    private void owns(Meeting... owned) {
        when(meetings.findByUserIdAndCreatedAtLessThanOrderByCreatedAtAsc(anyString(), any(Instant.class)))
                .thenReturn(List.of(owned));
        when(meetings.findByUserIdOrderByCreatedAtDesc(USER)).thenReturn(List.of(owned));
    }

    @Nested
    @DisplayName("setting the policy")
    class Setting {

        @Test
        @DisplayName("null on both dials means keep everything")
        void nullIsKeep() {
            service.setPolicy(USER, null, null);

            assertThat(user.getAudioRetentionDays()).isNull();
            assertThat(user.getMeetingRetentionDays()).isNull();
            assertThat(user.hasRetentionPolicy()).isFalse();
        }

        @Test
        @DisplayName("refuses to delete meetings sooner than the recordings inside them")
        void refusesAnIncoherentPair() {
            assertThatThrownBy(() -> service.setPolicy(USER, 90, 30))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("at least as long");
        }

        @Test
        @DisplayName("allows the two to be equal")
        void allowsEqual() {
            service.setPolicy(USER, 30, 30);

            assertThat(user.getAudioRetentionDays()).isEqualTo(30);
            assertThat(user.getMeetingRetentionDays()).isEqualTo(30);
        }

        @Test
        @DisplayName("refuses a window of zero days or of a century")
        void refusesNonsense() {
            assertThatThrownBy(() -> service.setPolicy(USER, 0, null))
                    .isInstanceOf(ApiException.class);
            assertThatThrownBy(() -> service.setPolicy(USER, null, 40_000))
                    .isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("is recorded in the audit log")
        void isAudited() {
            service.setPolicy(USER, 30, null);

            verify(audit).record(USER, "RETENTION_POLICY_SET", "user", USER);
        }
    }

    @Nested
    @DisplayName("the nightly pass")
    class Pass {

        @Test
        @DisplayName("does nothing at all when no dial is set")
        void noPolicyNoWork() {
            owns(aged("mtg_old", 400));

            assertThat(service.applyFor(user, TODAY).any()).isFalse();
            verify(erasure, never()).eraseAudio(any(Meeting.class));
            verify(erasure, never()).eraseMeeting(any(Meeting.class));
        }

        @Test
        @DisplayName("erases the recording of a meeting past the audio window, and keeps the meeting")
        void erasesAudioOnly() {
            user.setAudioRetentionDays(30);
            Meeting old = aged("mtg_old", 31);
            owns(old);

            RetentionService.Due done = service.applyFor(user, TODAY);

            assertThat(done.recordings()).isEqualTo(1);
            assertThat(done.meetings()).isZero();
            verify(erasure).eraseAudio(old);
            verify(erasure, never()).eraseMeeting(any(Meeting.class));
        }

        @Test
        @DisplayName("does not count a recording whose erasure was refused")
        void aRefusedErasureIsNotReported() {
            // Audio erasure is allowed to refuse now: it deletes the voiceprints
            // derived from the recording first, and will not delete the
            // recording unless that is confirmed. The nightly pass must not
            // report a deletion it did not achieve -- the count goes into the
            // account holder's "we deleted 4 recordings last night" notification
            // and into the audit log.
            user.setAudioRetentionDays(30);
            Meeting old = aged("mtg_old", 31);
            owns(old);
            doThrow(ApiException.serviceUnavailable("Speaker matching data could not be updated"))
                    .when(erasure).eraseAudio(old);

            // It propagates out of applyFor to the per-account catch in the
            // caller, which logs it and moves on to the next account. Tonight's
            // pass does nothing for this one; tomorrow's tries again, because
            // the meeting is still past the window and still has its audio.
            assertThatThrownBy(() -> service.applyFor(user, TODAY))
                    .isInstanceOf(ApiException.class);

            verify(notifications, never())
                    .retentionApplied(anyString(), anyInt(), anyInt(), any(LocalDate.class));
        }

        @Test
        @DisplayName("leaves a meeting that is exactly at the cut-off alone")
        void boundaryIsInclusiveOfTheDay() {
            user.setAudioRetentionDays(30);
            // Created 30 days ago at midday; the cut-off is midnight 30 days ago,
            // so this one is younger than the rule and survives another day.
            Meeting borderline = aged("mtg_edge", 30);
            when(meetings.findByUserIdAndCreatedAtLessThanOrderByCreatedAtAsc(anyString(), any(Instant.class)))
                    .thenReturn(List.of(borderline));

            assertThat(service.applyFor(user, TODAY).any()).isFalse();
            verify(erasure, never()).eraseAudio(any(Meeting.class));
        }

        @Test
        @DisplayName("counts a meeting past both windows once, as a meeting")
        void doesNotCountTheSameMeetingTwice() {
            user.setAudioRetentionDays(30);
            user.setMeetingRetentionDays(90);
            Meeting ancient = aged("mtg_ancient", 200);
            owns(ancient);

            RetentionService.Due done = service.applyFor(user, TODAY);

            assertThat(done.meetings()).isEqualTo(1);
            assertThat(done.recordings()).isZero();
            verify(erasure).eraseMeeting(ancient);
            verify(erasure, never()).eraseAudio(any(Meeting.class));
        }

        @Test
        @DisplayName("skips a meeting whose recording has already gone")
        void skipsAlreadyErasedAudio() {
            user.setAudioRetentionDays(30);
            Meeting done = aged("mtg_done", 100);
            done.setAudioDeletedAt(Instant.now());
            done.setObjectKey(null);
            owns(done);

            assertThat(service.applyFor(user, TODAY).any()).isFalse();
            verify(erasure, never()).eraseAudio(any(Meeting.class));
        }

        @Test
        @DisplayName("skips a URL import, which never had a recording of ours")
        void skipsMeetingsWithNoObject() {
            user.setAudioRetentionDays(30);
            Meeting imported = aged("mtg_yt", 100);
            imported.setObjectKey(null);
            imported.setSourceUrl("https://youtu.be/x");
            owns(imported);

            assertThat(service.applyFor(user, TODAY).any()).isFalse();
        }

        @Test
        @DisplayName("says what it did, and cannot be switched off")
        void notifiesTheOwner() {
            user.setAudioRetentionDays(30);
            owns(aged("mtg_old", 31));
            when(users.findWithRetentionPolicy()).thenReturn(List.of(user));

            assertThat(service.applyAll(TODAY)).isEqualTo(1);
            verify(notifications).retentionApplied(USER, 1, 0, TODAY);
        }

        @Test
        @DisplayName("says nothing on a night when nothing was old enough")
        void silentWhenNothingHappens() {
            user.setAudioRetentionDays(30);
            owns(aged("mtg_new", 2));
            when(users.findWithRetentionPolicy()).thenReturn(List.of(user));

            assertThat(service.applyAll(TODAY)).isZero();
            verify(notifications, never()).retentionApplied(anyString(), org.mockito.ArgumentMatchers.anyInt(),
                    org.mockito.ArgumentMatchers.anyInt(), any(LocalDate.class));
        }

        @Test
        @DisplayName("one account failing does not stop the others")
        void onwardAfterAFailure() {
            UserEntity other = new UserEntity();
            other.setId("usr_2");
            other.setAudioRetentionDays(30);
            user.setAudioRetentionDays(30);
            when(users.findWithRetentionPolicy()).thenReturn(List.of(user, other));
            when(meetings.findByUserIdAndCreatedAtLessThanOrderByCreatedAtAsc(
                    org.mockito.ArgumentMatchers.eq(USER), any(Instant.class)))
                    .thenThrow(new IllegalStateException("database went away"));
            when(meetings.findByUserIdAndCreatedAtLessThanOrderByCreatedAtAsc(
                    org.mockito.ArgumentMatchers.eq("usr_2"), any(Instant.class)))
                    .thenReturn(List.of(aged("mtg_old", 31)));

            assertThat(service.applyAll(TODAY)).isEqualTo(1);
            verify(notifications).retentionApplied(
                    org.mockito.ArgumentMatchers.eq("usr_2"), org.mockito.ArgumentMatchers.eq(1),
                    org.mockito.ArgumentMatchers.eq(0), any(LocalDate.class));
        }
    }

    @Nested
    @DisplayName("the preview")
    class Preview {

        @Test
        @DisplayName("counts what tonight would take, without taking it")
        void countsWithoutDeleting() {
            owns(aged("mtg_a", 100), aged("mtg_b", 40), aged("mtg_c", 2));

            RetentionService.Due due = service.preview(USER, 30, 90, TODAY);

            assertThat(due.meetings()).isEqualTo(1);
            assertThat(due.recordings()).isEqualTo(1);
            verify(erasure, never()).eraseAudio(any(Meeting.class));
            verify(erasure, never()).eraseMeeting(any(Meeting.class));
        }

        @Test
        @DisplayName("is empty when neither dial is set")
        void emptyWithoutAPolicy() {
            owns(aged("mtg_a", 1000));

            assertThat(service.preview(USER, null, null, TODAY).any()).isFalse();
        }
    }
}
