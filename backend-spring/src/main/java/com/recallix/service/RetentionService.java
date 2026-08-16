package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.entity.Meeting;
import com.recallix.entity.UserEntity;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.UserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.List;

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

    public RetentionService(UserRepository users,
                            MeetingRepository meetings,
                            ErasureService erasure,
                            NotificationService notifications,
                            AuditService audit) {
        this.users = users;
        this.meetings = meetings;
        this.erasure = erasure;
        this.notifications = notifications;
        this.audit = audit;
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
