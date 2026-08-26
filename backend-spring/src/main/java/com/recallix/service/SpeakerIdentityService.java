package com.recallix.service;

import com.recallix.dto.SpeakerProfileResponse;
import com.recallix.entity.TranscriptSegment;
import com.recallix.common.ApiException;
import com.recallix.repository.SpeakerProfileRepository;
import com.recallix.repository.UserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The consent gate in front of voice templates, and the controls over them.
 *
 * <p>This service owns the answer to one question that everything else defers
 * to: <em>is this account allowed to have voice data stored for it at all?</em>
 * It also owns the two things a person whose voice is held has a right to —
 * seeing what is held, and getting rid of it.
 *
 * <p>The vectors themselves are not here and cannot be reached from here. They
 * live in the ai-service, which holds the model and the key; see
 * {@code V53__speaker_profiles.sql} for the five rules and
 * {@code docs/speaker-identification.md} for the whole design.
 *
 * <h2>Why the gate is here rather than at the far end</h2>
 * The ai-service cannot read the {@code users} table — row-level security
 * confines it to rows belonging to the tenant on the connection, and it
 * deliberately has no bypass. So consent is checked by the service that owns
 * the user row, which is this one, before any call is made. The ai-service's own
 * defence is different in kind and complementary: with no encryption key
 * configured it can neither read nor write a template, so a misconfigured
 * deployment ends up with the feature off rather than on and unencrypted.
 *
 * <h2>Why switching it off deletes</h2>
 * A toggle that only stopped <em>new</em> learning would leave every existing
 * template in place, which is not what "off" means to the person reading it.
 * Withdrawing consent removes the data, not merely the use of it. The UI says so
 * before the switch moves.
 */
@Service
public class SpeakerIdentityService {

    private static final Logger log = LoggerFactory.getLogger(SpeakerIdentityService.class);

    private final UserRepository users;
    private final SpeakerProfileRepository profiles;
    private final AiClient ai;
    private final AuditService audit;

    public SpeakerIdentityService(UserRepository users,
                                  SpeakerProfileRepository profiles,
                                  AiClient ai,
                                  AuditService audit) {
        this.users = users;
        this.profiles = profiles;
        this.ai = ai;
        this.audit = audit;
    }

    /** Whether this account has opted in to storing voice templates. */
    @Transactional(readOnly = true)
    public boolean learningEnabled(String userId) {
        return users.findById(userId)
                .map(u -> u.isSpeakerLearningEnabled())
                .orElse(false);
    }

    /** The voices this account has named, most recently updated first. */
    @Transactional(readOnly = true)
    public List<SpeakerProfileResponse> list(String userId) {
        return profiles.findByUserIdOrderByUpdatedAtDesc(userId).stream()
                .map(SpeakerProfileResponse::from)
                .toList();
    }

    /**
     * Delete one named voice.
     *
     * <p>The ai-service deletes first and Spring's row goes with it — they are
     * the same row, reached two ways. If the far end fails this throws, because
     * the one outcome a deletion must never have is a success message over data
     * that is still there.
     */
    @Transactional
    public void deleteProfile(String userId, String profileId) {
        var profile = profiles.findByIdAndUserId(profileId, userId)
                .orElseThrow(() -> ApiException.notFound("No such speaker profile"));
        ai.forgetSpeakers(userId, profile.getId(), null);
        audit.record(userId, "SPEAKER_PROFILE_DELETED", "speaker_profile", profileId);
    }

    /**
     * Turn speaker learning on or off.
     *
     * <p>Turning it off erases every profile and every per-meeting voiceprint
     * the account holds, and the flag is only flipped once that has succeeded —
     * so a failure leaves the switch visibly still on rather than claiming an
     * erasure that did not happen.
     */
    @Transactional
    public void setLearningEnabled(String userId, boolean enabled) {
        var user = users.findById(userId)
                .orElseThrow(() -> ApiException.notFound("No such account"));
        if (user.isSpeakerLearningEnabled() == enabled) {
            return;
        }
        if (!enabled) {
            ai.forgetSpeakers(userId, null, null);
            profiles.deleteByUserId(userId);
        }
        user.setSpeakerLearningEnabled(enabled);
        audit.record(userId, enabled ? "SPEAKER_LEARNING_ENABLED" : "SPEAKER_LEARNING_DISABLED",
                "user", userId);
    }

    /** Erase everything, for a closing account. Never throws: closing must finish. */
    public void forgetEverything(String userId) {
        try {
            ai.forgetSpeakers(userId, null, null);
        } catch (RuntimeException e) {
            log.error("Could not erase speaker profiles for a closing account: {}",
                    e.getClass().getSimpleName());
        }
        profiles.deleteByUserId(userId);
    }

    /**
     * Erase the voiceprints derived from one recording.
     *
     * <p>Called when the audio is erased. The vector is not audio and cannot be
     * turned back into it, but it is a durable identifier built from that
     * person's voice on that recording — answering "delete the recording of me"
     * while keeping one would be a lie by omission.
     *
     * <p>Named profiles are untouched: those were created by a separate,
     * explicit act and are not tied to this meeting.
     */
    public void forgetMeeting(String userId, String meetingId) {
        try {
            ai.forgetSpeakers(userId, null, meetingId);
        } catch (RuntimeException e) {
            log.error("Could not erase voiceprints for an erased recording: {}",
                    e.getClass().getSimpleName());
        }
    }

    /**
     * The same deletion, for the caller that cannot proceed without it.
     *
     * <p>{@link #forgetMeeting} above is best-effort by design: it runs while a
     * recording is being erased or an account closed, and those must finish even
     * if the ai-service is down — the audio still goes, and a leftover vector is
     * chased by the operator. Losing the erasure is worse than losing the
     * confirmation.
     *
     * <p>Manual speaker correction inverts that. It is not a deletion the user
     * asked for; it is the invalidation that keeps a correction from making
     * things worse. A cached voiceprint is an average of the spans its speaker
     * key owned when it was computed, so moving spans between keys is precisely
     * the statement that the average is wrong. Save the correction while the
     * stale vector survives and the next "Rematch speakers" compares a blended
     * voice against the account's named profiles — and can put a real person's
     * name on the wrong speaker, which is the failure the correction was meant
     * to prevent. Swallowing that failure would leave the account quietly in the
     * state the user was trying to leave.
     *
     * <p>So this one throws. Three outcomes from the client and only one of them
     * proceeds: an exception (we do not know), an unconfirmed answer (it did not
     * happen), or confirmation that a DELETE ran — after which this meeting has
     * no cached voiceprints, whether it had five or none.
     *
     * <p>Named profiles are not reachable from here. The request carries a
     * meeting id and no profile id, and the far end deletes only from
     * {@code meeting_speaker_voiceprints}.
     *
     * @throws ApiException 503, with a sentence the caller can show, when the
     *                      invalidation cannot be confirmed
     */
    public void invalidateMeetingVoiceprintsRequired(String userId, String meetingId) {
        AiClient.ForgetResult result;
        try {
            result = ai.forgetMeetingVoiceprints(userId, meetingId);
        } catch (RuntimeException e) {
            log.error("Could not invalidate voiceprints for a corrected meeting: {}",
                    e.getClass().getSimpleName());
            throw ApiException.serviceUnavailable(INVALIDATION_FAILED);
        }
        if (!result.confirmed()) {
            // Reached the service, got an answer, and the answer was "no
            // deletion happened here". Same refusal: the difference between
            // this and the throw above is only how much we know.
            log.error("Voiceprint invalidation was not confirmed for a corrected meeting.");
            throw ApiException.serviceUnavailable(INVALIDATION_FAILED);
        }
    }

    /**
     * Said to the user when an operation is refused for want of this deletion.
     *
     * <p>Names the consequence rather than the component: "speaker matching" is
     * the feature they can see, and "nothing was changed" is the fact they need,
     * because the alternative is re-reading the page and believing it worked.
     *
     * <p>Deliberately neutral about <em>what</em> did not happen, because both
     * callers share it: a manual speaker correction and a reprocess. Naming one
     * would tell half the users about an operation they did not perform.
     */
    private static final String INVALIDATION_FAILED =
            "Speaker matching data could not be updated just now, so nothing was "
            + "changed. Try again in a moment.";

    /**
     * Group a meeting's segments into the shape the embedder needs.
     *
     * <p>Keyed on {@code speakerKey} — the meeting-local canonical identity that
     * survives renames — and never on the display name, which is the thing about
     * to change. A segment written before V46 has no key; those are skipped
     * rather than grouped by name, because two people who were both renamed to
     * the same thing would merge into one voiceprint that belongs to neither.
     *
     * <p>Insertion-ordered so that the turns arrive chronologically, which is
     * what makes the resulting spans readable in a log and reproducible in a
     * test.
     */
    public List<AiClient.SpeakerTurns> turnsOf(List<TranscriptSegment> segments) {
        Map<String, List<double[]>> spans = new LinkedHashMap<>();
        Map<String, String> names = new LinkedHashMap<>();

        for (var seg : segments) {
            String key = seg.getSpeakerKey();
            if (key == null || key.isBlank()) {
                continue;
            }
            // An unattributed turn has no voice of its own to learn from: the
            // provider declined to say whose it was, so the audio underneath it
            // may be anybody's or nobody's.
            if ("unknown".equals(seg.getSpeakerStatus())) {
                continue;
            }
            Double start = seg.getStartTime();
            Double end = seg.getEndTime();
            if (start == null || end == null || end <= start) {
                continue;
            }
            spans.computeIfAbsent(key, k -> new ArrayList<>()).add(new double[]{start, end});
            names.putIfAbsent(key, seg.getSpeaker() == null ? "" : seg.getSpeaker());
        }

        List<AiClient.SpeakerTurns> out = new ArrayList<>();
        for (var entry : spans.entrySet()) {
            out.add(new AiClient.SpeakerTurns(
                    entry.getKey(), names.getOrDefault(entry.getKey(), ""), entry.getValue()));
        }
        return out;
    }
}
