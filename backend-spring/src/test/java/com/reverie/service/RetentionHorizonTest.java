package com.reverie.service;

import com.reverie.entity.Meeting;
import com.reverie.entity.UserEntity;
import com.reverie.repository.MeetingRepository;
import com.reverie.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.NavigableMap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

/**
 * Which day each impending deletion lands on.
 *
 * <h2>Why this exists as its own thing</h2>
 *
 * <p>The retention warning used to be deduplicated by the day it was
 * <em>sent</em> — "at most one a week" — and that is wrong in precisely the case
 * the warning is for:
 *
 * <pre>
 *   Mon   A and B are due on the 20th          -> warned
 *   Tue   C crosses the horizon, due the 21st  -> suppressed, six days to go
 *   21st  C is deleted. Nobody was ever told.
 * </pre>
 *
 * <p>A message can only be deduplicated by the thing it is about, so the thing
 * it is about has to have an identity. That is what this produces: the window
 * split by the day the deletion actually happens, so each batch is
 * {@code (user, date)} and can be keyed on.
 *
 * <p>The dates are derived from {@code olderThan}'s own rule rather than
 * approximated — a warning that names a day the pass disagrees with is worse
 * than no warning.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class RetentionHorizonTest {

    private static final String USER = "usr_1";
    /** A Thursday, so nothing here can accidentally depend on a weekday. */
    private static final LocalDate TODAY = LocalDate.of(2026, 3, 5);

    @Mock private UserRepository users;
    @Mock private MeetingRepository meetings;
    @Mock private ErasureService erasure;
    @Mock private NotificationService notifications;
    @Mock private AuditService audit;
    @Mock private AccountMail mail;

    private RetentionService retention;
    private UserEntity user;
    private final List<Meeting> owned = new ArrayList<>();

    @BeforeEach
    void setUp() {
        retention = new RetentionService(users, meetings, erasure, notifications, audit, mail);
        user = new UserEntity();
        user.setId(USER);
        when(meetings.findByUserIdOrderByCreatedAtDesc(USER)).thenReturn(owned);
    }

    /** A meeting created {@code daysAgo} days before TODAY, at midday UTC. */
    private Meeting aged(String id, int daysAgo, boolean withAudio) {
        Meeting m = new Meeting();
        m.setId(id);
        m.setUserId(USER);
        m.setCreatedAt(TODAY.minusDays(daysAgo).atTime(12, 0).toInstant(ZoneOffset.UTC));
        if (withAudio) {
            m.setObjectKey("audio/" + id);
        }
        owned.add(m);
        return m;
    }

    private NavigableMap<LocalDate, RetentionService.Due> week() {
        return retention.upcoming(user, TODAY.plusDays(1), TODAY.plusDays(7));
    }

    @Test
    @DisplayName("names the day the pass will actually delete it")
    void agreesWithThePass() {
        /*
         * olderThan erases on the first day D where createdAt < (D - days) at
         * midnight, which is created + days + 1. Created 25 days ago with a
         * 30-day window: 5 days of life left, so the 6th day from today.
         */
        user.setMeetingRetentionDays(30);
        aged("mtg_a", 25, true);

        assertThat(week()).containsOnlyKeys(TODAY.plusDays(6));

        // And the pass agrees: nothing on the day before, everything on the day.
        assertThat(retention.preview(USER, null, 30, TODAY.plusDays(5)).any()).isFalse();
        assertThat(retention.preview(USER, null, 30, TODAY.plusDays(6)).meetings()).isEqualTo(1);
    }

    @Test
    @DisplayName("gives two batches a day apart their own days")
    void twoBatches() {
        // The case the old rule swallowed.
        user.setMeetingRetentionDays(30);
        aged("mtg_a", 25, true);
        aged("mtg_b", 24, true);

        assertThat(week()).containsOnlyKeys(TODAY.plusDays(6), TODAY.plusDays(7));
        assertThat(week().get(TODAY.plusDays(6)).meetings()).isEqualTo(1);
        assertThat(week().get(TODAY.plusDays(7)).meetings()).isEqualTo(1);
    }

    @Test
    @DisplayName("groups everything landing on one day into one batch")
    void oneBatch() {
        // Two meetings, one day, one warning. Never one message per meeting.
        user.setMeetingRetentionDays(30);
        aged("mtg_a", 25, true);
        aged("mtg_b", 25, true);

        assertThat(week()).containsOnlyKeys(TODAY.plusDays(6));
        assertThat(week().get(TODAY.plusDays(6)).meetings()).isEqualTo(2);
    }

    @Test
    @DisplayName("counts a recording and the meeting it belongs to as two events")
    void audioThenMeeting() {
        /*
         * A short audio window and a long meeting window: the recording goes
         * first and the meeting goes later. Both are irreversible and both
         * deserve their own notice.
         */
        user.setAudioRetentionDays(30);
        user.setMeetingRetentionDays(33);
        aged("mtg_a", 27, true);

        NavigableMap<LocalDate, RetentionService.Due> week = week();
        assertThat(week).containsOnlyKeys(TODAY.plusDays(4), TODAY.plusDays(7));
        assertThat(week.get(TODAY.plusDays(4)).recordings()).isEqualTo(1);
        assertThat(week.get(TODAY.plusDays(4)).meetings()).isZero();
        assertThat(week.get(TODAY.plusDays(7)).meetings()).isEqualTo(1);
    }

    @Test
    @DisplayName("counts a meeting once when the whole thing goes on the same day")
    void notCountedTwice() {
        // The pass checks the meeting rule first and the audio goes with it, so
        // counting the recording as well would overstate what is about to be lost.
        user.setAudioRetentionDays(30);
        user.setMeetingRetentionDays(30);
        aged("mtg_a", 25, true);

        NavigableMap<LocalDate, RetentionService.Due> week = week();
        assertThat(week).containsOnlyKeys(TODAY.plusDays(6));
        assertThat(week.get(TODAY.plusDays(6)).meetings()).isEqualTo(1);
        assertThat(week.get(TODAY.plusDays(6)).recordings()).isZero();
    }

    @Test
    @DisplayName("says nothing about a recording that is already gone")
    void alreadyErased() {
        user.setAudioRetentionDays(30);
        Meeting m = aged("mtg_a", 25, true);
        m.setAudioDeletedAt(TODAY.minusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant());

        assertThat(week()).isEmpty();
    }

    @Test
    @DisplayName("is empty outside the window, in both directions")
    void windowed() {
        user.setMeetingRetentionDays(30);
        aged("mtg_soon", 40, true);   // already overdue; the pass, not a warning
        aged("mtg_later", 10, true);  // three weeks away

        assertThat(week()).isEmpty();
    }

    @Test
    @DisplayName("is empty for an account with no policy at all")
    void noPolicy() {
        aged("mtg_a", 400, true);

        assertThat(week()).isEmpty();
    }
}
