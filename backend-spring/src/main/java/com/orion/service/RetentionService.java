package com.orion.service;

import com.orion.common.ApiException;
import com.orion.entity.Meeting;
import com.orion.entity.UserEntity;
import com.orion.repository.MeetingRepository;
import com.orion.repository.UserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.NavigableMap;
import java.util.TreeMap;

/**
 * Throwing things away on a schedule, because somebody asked us to.
 *
 * <p>Two dials, not one. "How long do you keep the recording of my voice" is
 * asked by the people who were in the meeting; "how long do you keep the notes"
 * is asked by the person who owns the account. Thirty days and forever is a
 * coherent and common answer to that pair, and a single number cannot express
 * it. Both default to null — keep everything — because a retention policy that
 * switched itself on during a deploy would delete data nobody agreed to lose.
 *
 * <p><strong>Age is measured from when the meeting was created</strong>, not
 * from when it was last opened. Last-touched retention sounds kinder and is the
 * wrong promise: it means the recording of a sensitive conversation survives
 * indefinitely precisely because people keep going back to it. What is being
 * promised here is "we do not keep this beyond N days", and only the creation
 * date can keep that promise.
 *
 * <p><strong>The narrower rule is checked first.</strong> A meeting past both
 * cut-offs is deleted whole and never counted twice — the audio inside it went
 * with it, and reporting "1 recording and 1 meeting deleted" for one meeting is
 * a lie about the size of what happened.
 */
@Service
public class RetentionService {

    private static final Logger log = LoggerFactory.getLogger(RetentionService.class);

    /** Ten years. Longer than this is indistinguishable from "keep", which is null. */
    public static final int MAX_DAYS = 3650;

    private final UserRepository users;
    private final MeetingRepository meetings;
    private final ErasureService erasure;
    private final NotificationService notifications;
    private final AuditService audit;
    private final AccountMail mail;

    public RetentionService(UserRepository users,
                            MeetingRepository meetings,
                            ErasureService erasure,
                            NotificationService notifications,
                            AuditService audit,
                            AccountMail mail) {
        this.users = users;
        this.meetings = meetings;
        this.erasure = erasure;
        this.notifications = notifications;
        this.audit = audit;
        this.mail = mail;
    }

    /* ------------------------------ the policy ----------------------------- */

    /**
     * Set or clear the two windows.
     *
     * <p>Rejects a whole-meeting window shorter than the audio one. Nothing
     * would break — the meeting simply goes first — but it means the narrower
     * promise, the one about the recording, never actually runs, and a policy
     * that silently does not do the thing it was set up to do is worse than one
     * that refuses to be saved.
     *
     * @param audioDays   days to keep recordings, or null to keep them
     * @param meetingDays days to keep meetings, or null to keep them
     */
    @Transactional
    public UserEntity setPolicy(String userId, Integer audioDays, Integer meetingDays) {
        Integer audio = validate(audioDays, "Recording retention");
        Integer meeting = validate(meetingDays, "Meeting retention");
        if (audio != null && meeting != null && meeting < audio) {
            throw ApiException.badRequest(
                    "Meetings would be deleted before their recordings are, which makes the "
                            + "recording rule meaningless. Keep meetings at least as long as recordings.");
        }

        UserEntity user = users.findById(userId)
                .orElseThrow(() -> ApiException.unauthorized("Unknown user"));
        user.setAudioRetentionDays(audio);
        user.setMeetingRetentionDays(meeting);
        audit.record(userId, "RETENTION_POLICY_SET", "user", userId);
        return user;
    }

    private static Integer validate(Integer days, String what) {
        if (days == null) {
            return null;
        }
        if (days < 1 || days > MAX_DAYS) {
            throw ApiException.badRequest(what + " must be between 1 and " + MAX_DAYS + " days.");
        }
        return days;
    }

    /**
     * What tonight's pass would delete, without deleting it.
     *
     * <p>The settings page shows this next to the dials. A retention control
     * that cannot answer "and what does that mean for what I have now" is one
     * people set to the wrong number and find out about months later.
     */
    @Transactional(readOnly = true)
    public Due preview(String userId, Integer audioDays, Integer meetingDays, LocalDate today) {
        List<Meeting> owned = meetings.findByUserIdOrderByCreatedAtDesc(userId);
        int recordings = 0;
        int whole = 0;
        for (Meeting m : owned) {
            if (meetingDays != null && olderThan(m, meetingDays, today)) {
                whole++;
            } else if (audioDays != null && olderThan(m, audioDays, today) && hasAudio(m)) {
                recordings++;
            }
        }
        return new Due(recordings, whole);
    }

    /**
     * What each of the next few days will delete, day by day.
     *
     * <h2>Why the warning needs this and {@link #preview} will not do</h2>
     *
     * <p>{@code preview} answers "what would a pass on date D delete", which is
     * cumulative — everything already overdue plus everything newly due. Asked
     * with the clock a week forward it gives one lump with no way to tell which
     * day any of it belongs to, and a warning keyed off that lump can only be
     * deduplicated by <em>when it was sent</em>. That is the rule this replaces,
     * and it is wrong in exactly the case the warning exists for: warn on Monday
     * about next Monday's batch, and the batch that crosses the horizon on
     * Tuesday is suppressed for six days and then deleted, unwarned.
     *
     * <p>This splits the window by the day the deletion actually lands, so each
     * batch is a thing with an identity — {@code (user, date)} — that a message
     * can be keyed to. Two batches a day apart get two warnings; the same batch
     * gets one however often the job runs.
     *
     * <h2>The arithmetic, stated once</h2>
     *
     * <p>{@link #olderThan} erases a meeting on the first day D where
     * {@code createdAt < (D - days) at midnight UTC}, which is
     * {@code created + days + 1}. That is the whole of the date rule and it is
     * derived here rather than approximated, so a warning cannot name a day the
     * pass disagrees with.
     *
     * <p>A meeting can appear twice, on two different days, and that is correct:
     * with a short audio window and a long meeting window the recording goes
     * first and the meeting goes later. Both are irreversible and both deserve
     * their own notice. It appears once when the whole meeting goes first or on
     * the same day — the pass counts it once there too, because the audio goes
     * with it.
     *
     * @return deletion date to what that date takes, ascending, empty days absent
     */
    @Transactional(readOnly = true)
    public NavigableMap<LocalDate, Due> upcoming(UserEntity user, LocalDate from, LocalDate through) {
        NavigableMap<LocalDate, int[]> tally = new TreeMap<>();
        Integer audioDays = user.getAudioRetentionDays();
        Integer meetingDays = user.getMeetingRetentionDays();
        if (audioDays == null && meetingDays == null) {
            return new TreeMap<>();
        }

        for (Meeting meeting : meetings.findByUserIdOrderByCreatedAtDesc(user.getId())) {
            if (meeting.getCreatedAt() == null) {
                continue;
            }
            LocalDate created = meeting.getCreatedAt().atZone(ZoneOffset.UTC).toLocalDate();
            LocalDate meetingOn = meetingDays == null ? null : created.plusDays(meetingDays + 1L);
            LocalDate audioOn = (audioDays == null || !hasAudio(meeting))
                    ? null : created.plusDays(audioDays + 1L);

            // The recording is its own event only when it goes strictly first.
            // On the same day the pass takes the meeting branch and the audio is
            // counted with it, so counting it here as well would overstate.
            if (audioOn != null && (meetingOn == null || audioOn.isBefore(meetingOn))) {
                add(tally, audioOn, from, through, 0);
            }
            if (meetingOn != null) {
                add(tally, meetingOn, from, through, 1);
            }
        }

        NavigableMap<LocalDate, Due> out = new TreeMap<>();
        tally.forEach((day, counts) -> out.put(day, new Due(counts[0], counts[1])));
        return out;
    }

    private static void add(NavigableMap<LocalDate, int[]> tally, LocalDate day,
                            LocalDate from, LocalDate through, int slot) {
        if (day.isBefore(from) || day.isAfter(through)) {
            return;
        }
        tally.computeIfAbsent(day, d -> new int[2])[slot]++;
    }

    /* ------------------------------- the pass ------------------------------ */

    /**
     * Apply every account's policy.
     *
     * <p>One transaction, like the reminder digest and for the same reason: a
     * workspace is one account, and the alternative needs a second bean to get
     * past self-invocation for no benefit anybody can measure at this scale.
     *
     * <p>A failure on one account is caught and logged rather than abandoning
     * the rest — one meeting whose object store is briefly unreachable must not
     * mean nobody's policy runs tonight.
     *
     * @return how many accounts had something deleted
     */
    @Transactional
    public int applyAll(LocalDate today) {
        int touched = 0;
        for (UserEntity user : users.findWithRetentionPolicy()) {
            try {
                Due done = applyFor(user, today);
                if (done.any()) {
                    touched++;
                    notifications.retentionApplied(user.getId(), done.recordings(), done.meetings(), today);
                    /*
                     * Inside this transaction, on purpose. The bell only reaches
                     * somebody who opens the app; this ran unattended at three in
                     * the morning and cannot be undone. Queueing the message here
                     * means the deletion and the record of it commit together --
                     * if the pass rolls back there is no message, and if Resend is
                     * unreachable the message waits rather than being lost.
                     *
                     * The previous version sent inline, in a REQUIRES_NEW
                     * transaction, and a ninety-second provider outage silently
                     * cost the account holder any notice that their data had gone.
                     */
                    mail.retentionApplied(user.getId(), done.recordings(), done.meetings(), today);
                    audit.record(user.getId(), "RETENTION_APPLIED", "user", user.getId());
                    log.info("Retention deleted {} recording(s) and {} meeting(s) for {}",
                            done.recordings(), done.meetings(), user.getId());
                }
            } catch (RuntimeException e) {
                log.error("Retention failed for {}: {}", user.getId(), e.toString(), e);
            }
        }
        return touched;
    }

    /** One account's policy, applied. Package-private so the tests can drive it directly. */
    Due applyFor(UserEntity user, LocalDate today) {
        Integer audioDays = user.getAudioRetentionDays();
        Integer meetingDays = user.getMeetingRetentionDays();
        // The widest window decides what is even worth loading: nothing younger
        // than the shorter of the two can be affected by either rule.
        Integer shortest = shortest(audioDays, meetingDays);
        if (shortest == null) {
            return Due.NOTHING;
        }

        List<Meeting> candidates = meetings.findByUserIdAndCreatedAtLessThanOrderByCreatedAtAsc(
                user.getId(), cutoff(shortest, today));

        int recordings = 0;
        int whole = 0;
        for (Meeting meeting : candidates) {
            if (meetingDays != null && olderThan(meeting, meetingDays, today)) {
                erasure.eraseMeeting(meeting);
                whole++;
                // Counted once. The audio went with it, and saying so twice
                // would overstate what happened tonight.
                continue;
            }
            if (audioDays != null && olderThan(meeting, audioDays, today) && hasAudio(meeting)) {
                erasure.eraseAudio(meeting);
                recordings++;
            }
        }
        return new Due(recordings, whole);
    }

    /* ------------------------------- helpers ------------------------------- */

    /**
     * What a pass did, or would do.
     *
     * @param recordings meetings whose audio went, notes kept
     * @param meetings   meetings that went entirely
     */
    public record Due(int recordings, int meetings) {
        static final Due NOTHING = new Due(0, 0);

        public boolean any() {
            return recordings > 0 || meetings > 0;
        }
    }

    private static Integer shortest(Integer a, Integer b) {
        if (a == null) {
            return b;
        }
        if (b == null) {
            return a;
        }
        return Math.min(a, b);
    }

    /**
     * Midnight UTC, {@code days} ago.
     *
     * <p>Day-grained rather than to the second so that a meeting is not deleted
     * at 14:07 because that is when it was uploaded thirty days ago. The pass
     * runs once a night; pretending to a precision it does not have would only
     * make the rule harder to reason about.
     */
    private static Instant cutoff(int days, LocalDate today) {
        return today.minusDays(days).atStartOfDay(ZoneOffset.UTC).toInstant();
    }

    private static boolean olderThan(Meeting meeting, int days, LocalDate today) {
        return meeting.getCreatedAt() != null && meeting.getCreatedAt().isBefore(cutoff(days, today));
    }

    /** Nothing to erase if it never had a recording, or has already lost it. */
    private static boolean hasAudio(Meeting meeting) {
        return meeting.getAudioDeletedAt() == null && meeting.getObjectKey() != null;
    }

    /** How old a meeting is, in whole days — used by the inventory. */
    public static long ageInDays(Meeting meeting, LocalDate today) {
        if (meeting.getCreatedAt() == null) {
            return 0;
        }
        return ChronoUnit.DAYS.between(
                meeting.getCreatedAt().atZone(ZoneOffset.UTC).toLocalDate(), today);
    }
}
