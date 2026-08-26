package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.domain.MeetingStatus;
import com.recallix.dto.StatusEvent;
import com.recallix.entity.Meeting;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingSummaryRepository;
import com.recallix.repository.MeetingTranscriptRepository;
import com.recallix.repository.MeetingTranslationRepository;
import com.recallix.repository.TranscriptChunkRepository;
import com.recallix.repository.TranscriptMomentRepository;
import com.recallix.repository.TranscriptSegmentRepository;
import com.recallix.repository.UserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;

/**
 * Deleting things, at the four grains anybody actually asks for.
 *
 * <p>"Delete the meeting" was the only unit Recallix offered, and it is the
 * wrong one for the commonest real request. The recording is the sensitive
 * artefact — somebody's voice, the largest object, the one thing that can be
 * replayed out of context and the one thing a participant might ask about
 * afterwards. The notes drawn from it are usually the part worth keeping. So
 * audio and transcript can each go on their own, and what remains says which,
 * and when.
 *
 * <p><strong>Every method here is the real thing.</strong> Nothing is marked
 * deleted and hidden; nothing waits in a bin for thirty days. A privacy control
 * that keeps the data and stops showing it to you is worse than no control at
 * all, because it produces a confident answer — "yes, I deleted that" — which is
 * false. The cost of that choice is that none of this can be undone, and every
 * caller says so before it happens.
 *
     * <p><strong>Storage first, then the row.</strong> The object store is not in
 * the transaction. If it is deleted first and the transaction then rolls back,
 * the result is a meeting whose audio is gone but which still claims to have it —
 * recoverable, visible, and reported by the page. The other order leaves an
 * orphaned object no key in the database points at: invisible, unbilled to
 * anybody's attention, and still holding the voice somebody asked us to erase.
 * The first failure is the one worth having.
 *
 * <p><strong>And derived data before either.</strong> Erasing a recording
 * also erases the voiceprints taken from it, and that deletion runs first
 * and is required rather than best-effort — see {@link #eraseAudio(Meeting)}
 * for the failure modes both ways round. The short version: a failure there
 * leaves the audio in place and says so, and a failure after it leaves a
 * cache missing rather than a template stranded.
 *
 * <p>Used by three callers with the same code path in each: the account holder
 * pressing a button, the nightly retention pass in {@link RetentionService}, and
 * {@link PrivacyService} closing an account. A retention rule that deleted
 * things differently from the button would be a second implementation to keep
 * honest.
 */
@Service
public class ErasureService {

    private static final Logger log = LoggerFactory.getLogger(ErasureService.class);

    private final MeetingRepository meetings;
    private final MeetingTranscriptRepository transcripts;
    private final TranscriptSegmentRepository segments;
    private final MeetingSummaryRepository summaries;
    private final MeetingActionItemRepository actionItems;
    private final MeetingTranslationRepository translations;
    private final TranscriptMomentRepository moments;
    private final TranscriptChunkRepository chunks;
    private final UserRepository users;
    private final StorageService storage;
    private final AuditService audit;
    private final StatusPublisher statusPublisher;

    private final SpeakerIdentityService speakerIdentity;

    public ErasureService(MeetingRepository meetings,
                          MeetingTranscriptRepository transcripts,
                          TranscriptSegmentRepository segments,
                          MeetingSummaryRepository summaries,
                          MeetingActionItemRepository actionItems,
                          MeetingTranslationRepository translations,
                          TranscriptMomentRepository moments,
                          TranscriptChunkRepository chunks,
                          UserRepository users,
                          StorageService storage,
                          AuditService audit,
                          StatusPublisher statusPublisher,
                          SpeakerIdentityService speakerIdentity) {
        this.statusPublisher = statusPublisher;
        this.speakerIdentity = speakerIdentity;
        this.meetings = meetings;
        this.transcripts = transcripts;
        this.segments = segments;
        this.summaries = summaries;
        this.actionItems = actionItems;
        this.translations = translations;
        this.moments = moments;
        this.chunks = chunks;
        this.users = users;
        this.storage = storage;
        this.audit = audit;
    }

    /* ----------------------------- the recording ---------------------------- */

    /**
     * Erase the audio and keep everything drawn from it.
     *
     * <p>Idempotent: asking twice is not an error, because the honest answer to
     * "delete this" when it is already gone is yes. Asking twice will, however,
     * re-confirm that the derived voiceprints are gone — see below — so a second
     * press can finish an erasure that only half happened.
     *
     * @throws ApiException 503 when the derived voiceprints cannot be confirmed
     *                      deleted, or when the object store refuses; in both
     *                      cases the meeting still says it has its recording
     */
    @Transactional
    public Instant eraseAudio(String userId, String meetingId) {
        Meeting meeting = require(userId, meetingId);
        Instant at = eraseAudio(meeting);
        audit.record(userId, "MEETING_AUDIO_ERASED", "meeting", meetingId);
        return at;
    }

    /**
     * The same, for a meeting already loaded and already known to be the caller's.
     *
     * <h2>The order, and why it is this one</h2>
     *
     * <p>Three things have to happen: the derived voiceprints go, the object
     * goes, and the row says so. The object store is not in the transaction, so
     * some interleaving of "done" and "not done" is reachable no matter what,
     * and the only real choice is which leftover to have.
     *
     * <p><strong>Voiceprints first.</strong>
     *
     * <ul>
     *   <li>If the voiceprint deletion fails, nothing else has run: the audio is
     *       still there, the row still says so, and the caller is told plainly
     *       that the erasure did not happen. Nothing was retained behind a
     *       claim that it was not.</li>
     *   <li>If it succeeds and the object store then fails, the transaction
     *       rolls back and the voiceprints stay deleted. The leftover state is
     *       "audio present, derived data absent" — safe, self-correcting, and
     *       cheap: the vectors are a cache and the next rematch rebuilds them
     *       from the audio that is still there. They are deliberately not
     *       recreated to compensate.</li>
     * </ul>
     *
     * <p>The other order — object first, voiceprints second — fails the other
     * way: a failure after the delete leaves the recording gone from the bucket
     * while the biometric-adjacent template derived from it survives, and the
     * row, rolled back, still claims the meeting has its recording. That is the
     * worst of the reachable states: more sensitive data retained, less of it
     * visible, and a dangling key. It is also unrecoverable in kind rather than
     * degree — a voiceprint whose audio is gone cannot be recomputed or checked
     * against anything.
     *
     * <p>So: least sensitive data retained on failure wins, and that is this
     * order. What it costs is that a failing ai-service blocks audio erasure
     * entirely. That is the trade taken deliberately — the erasure is refused
     * and reported, not silently half-done, and a retry completes it.
     *
     * <p><strong>The object still goes before the row.</strong> Unchanged, and
     * for the reason at the top of this class: a row written first and then
     * rolled back leaves an orphan nobody can see.
     */
    Instant eraseAudio(Meeting meeting) {
        // The voiceprints computed from this recording. An ECAPA embedding is
        // not audio and cannot be turned back into audio, so it is tempting to
        // argue it survives a request to delete the recording. It should not: it
        // is a durable identifier derived from the voices on that recording, and
        // it is the specific thing that makes those voices findable again.
        // Keeping it would answer "delete the recording of me" with a
        // technicality.
        //
        // Required rather than best-effort. This used to be a swallowed failure
        // at the end of the method, which meant the reachable state was: audio
        // deleted, row says "erased", template still in the database, nobody
        // told. A privacy control that reports a deletion it did not perform is
        // worse than no control at all.
        //
        // Deliberately BEFORE the already-erased check below, so that pressing
        // the button again on a meeting whose erasure half-completed finishes
        // the job rather than returning the timestamp of the half that did.
        // Deleting nothing is a confirmed success, so the repeat costs one
        // round trip and changes nothing.
        //
        // Named profiles are untouched. Those were created by a separate,
        // explicit act about a person, not about this file, and they are what
        // the account holder switched the feature on for. Only this meeting's
        // rows are in scope: the request carries a meeting id and no profile id.
        speakerIdentity.invalidateMeetingVoiceprintsRequired(
                meeting.getUserId(), meeting.getId());

        if (meeting.getAudioDeletedAt() != null) {
            return meeting.getAudioDeletedAt();
        }

        try {
            storage.deleteOrThrow(meeting.getObjectKey());
        } catch (RuntimeException e) {
            // Not swallowed, and not turned into a 500. The recording is still
            // in the bucket, so the meeting must go on saying it has one --
            // which is what rolling back achieves, since nothing below has run.
            log.error("Could not delete the recording for meeting {}: {}",
                    meeting.getId(), e.getClass().getSimpleName());
            throw ApiException.serviceUnavailable(
                    "The recording could not be deleted just now. It is still here, and "
                    + "the meeting is unchanged; try again in a moment.");
        }
        meeting.setObjectKey(null);
        // A YouTube import keeps its source URL — that is where the audio came
        // from, not a copy we hold — but the player must stop offering it, or
        // "the recording is deleted" is a claim the page immediately contradicts.
        meeting.setAudioUrl(null);
        meeting.setAudioDeletedAt(Instant.now());

        return meeting.getAudioDeletedAt();
    }

    /* ---------------------------- the transcript ---------------------------- */

    /**
     * Erase the words and keep the notes.
     *
     * <p>Takes the segments, the marks made on them, every translation of them
     * and the embeddings behind chat and semantic search. Leaving any one of
     * those would mean the product could still reproduce text the account holder
     * was told had been deleted — most sharply the embeddings, which are read by
     * a feature that answers in prose and cites its source.
     *
     * <p>The summary, the action items and the decisions survive. They are
     * derived, they are short, and they are what somebody keeping a record of a
     * meeting is actually keeping. Anyone who wants those gone too is one menu
     * item away from deleting the meeting.
     */
    @Transactional
    public Instant eraseTranscript(String userId, String meetingId) {
        Meeting meeting = require(userId, meetingId);
        Instant at = eraseTranscript(meeting);
        audit.record(userId, "MEETING_TRANSCRIPT_ERASED", "meeting", meetingId);
        return at;
    }

    Instant eraseTranscript(Meeting meeting) {
        if (meeting.getTranscriptDeletedAt() != null) {
            return meeting.getTranscriptDeletedAt();
        }
        String meetingId = meeting.getId();
        // The meeting row first, before any of the rows drawn from it. The
        // ai-service's indexer takes the same row before it replaces
        // `transcript_chunks`, and taking the chunks first here was an inverted
        // lock order: run the two together and PostgreSQL kills one of them.
        // Nothing slow happens between here and the commit.
        meetings.lockForWrite(meetingId);

        transcripts.deleteByMeetingId(meetingId);
        segments.deleteByMeetingId(meetingId);
        moments.deleteByMeetingId(meetingId);
        translations.deleteByMeetingId(meetingId);
        // Not wrapped in a try. This used to be caught and logged, on the
        // reasoning that the rest of the transcript should still go -- but the
        // embeddings are the one leftover that can still speak, in prose, with
        // a citation. "Deleted, except for the part that can quote it back to
        // you" is not a deletion, and a caller told the erasure succeeded has no
        // way to find out otherwise. If this cannot be done, none of it is done.
        chunks.deleteByMeetingId(meetingId);

        // Invalidate every execution that is already in flight.
        //
        // Erasure does not otherwise touch this number, and that was a way back
        // in: a pipeline run that started before the erasure wakes up
        // afterwards, finds the attempt it was given still current, and writes
        // its transcript and its embeddings over the deletion -- through
        // `applyResult`, which replaces the transcript wholesale, and through
        // the indexer, which replaces the chunks. Moving it makes both of those
        // stale by the check they already perform, so the erased meeting stays
        // erased without either side needing to know that erasure exists.
        meeting.setProcessingAttempt(meeting.getProcessingAttempt() + 1);
        meeting.setTranscriptDeletedAt(Instant.now());
        stopAnyRunInFlight(meeting);

        return meeting.getTranscriptDeletedAt();
    }

    /**
     * Take the meeting out of a processing state the increment above just
     * emptied.
     *
     * <p>Bumping the attempt makes every callback from the run that is currently
     * going stale, which is the point — it is what stops that run writing its
     * transcript over the erasure. But the meeting was left saying
     * {@code TRANSCRIBING}, and now nothing will ever say otherwise: the worker
     * will finish, report in, be recognised as an overtaken run and ignored, and
     * the status will sit there. A spinner with nothing behind it, permanently.
     *
     * <p>{@code FAILED} rather than a new {@code CANCELLED} status. The set of
     * meeting states is small on purpose and every screen, filter and export
     * knows it; adding a ninth for one corner would mean auditing all of them.
     * FAILED is also honest about what happened — this run produced nothing —
     * and it is the state the product already offers a way out of, so the meeting
     * remains reprocessable. The message says who stopped it, because "failed"
     * on its own about something the user deliberately did would be alarming.
     *
     * <p>Only a run actually in flight is touched. Erasing the transcript of a
     * finished meeting leaves it {@code READY}, which is what it is: the summary,
     * the action items and the decisions are all still there, and only the words
     * are gone.
     */
    private void stopAnyRunInFlight(Meeting meeting) {
        MeetingStatus status = meeting.getStatus();
        boolean running = status == MeetingStatus.QUEUED
                || status == MeetingStatus.TRANSCRIBING
                || status == MeetingStatus.SUMMARIZING
                || status == MeetingStatus.EXTRACTING;
        if (!running) {
            return;
        }
        meeting.setStatus(MeetingStatus.FAILED);
        meeting.setErrorMessage("Processing stopped because the transcript was erased.");
        // For the page that is open right now. There is deliberately no bell
        // notification: the user pressed the button that caused this a moment
        // ago, and telling them their own deletion failed something would be
        // noise. The status frame is different — without it the tab they are
        // looking at keeps its progress bar until they reload.
        status(meeting);
    }

    private void status(Meeting meeting) {
        statusPublisher.publish(new StatusEvent(
                meeting.getId(), meeting.getStatus(), 100, meeting.getErrorMessage()));
    }

    /* ----------------------------- the meeting ------------------------------ */

    /**
     * Erase the meeting and everything about it.
     *
     * <p>Most of the children go by foreign key cascade — chunks, chat, marks,
     * insights, shares, notifications. The five removed explicitly are the ones
     * Spring holds entities for and may have in its persistence context; letting
     * the database delete rows Hibernate still believes in is how a later flush
     * in the same transaction resurrects one.
     */
    @Transactional
    public void eraseMeeting(String userId, String meetingId) {
        Meeting meeting = require(userId, meetingId);
        eraseMeeting(meeting);
        audit.record(userId, "MEETING_DELETED", "meeting", meetingId);
    }

    void eraseMeeting(Meeting meeting) {
        String meetingId = meeting.getId();
        transcripts.deleteByMeetingId(meetingId);
        segments.deleteByMeetingId(meetingId);
        summaries.deleteByMeetingId(meetingId);
        actionItems.deleteByMeetingId(meetingId);
        translations.deleteByMeetingId(meetingId);
        storage.delete(meeting.getObjectKey());
        meetings.delete(meeting);
    }

    /* ----------------------------- the account ------------------------------ */

    /**
     * Erase the account and everything in it.
     *
     * <p>Two steps, and the second is one row. Every user-owned table in the
     * schema declares {@code user_id ... REFERENCES users(id) ON DELETE CASCADE},
     * so deleting the user is the deletion — meetings, transcripts, embeddings,
     * chats, marks, projects, notifications, shares, audit log and all. That is
     * worth stating plainly because the alternative, a hand-written list of
     * thirty tables, is a list that silently stops being complete the first time
     * somebody adds a table and forgets this method.
     *
     * <p>The objects in storage are the part the database cannot reach, so they
     * go first and one at a time. A failure there is logged and does not stop the
     * rest: an account holder who asked to be forgotten and got "something went
     * wrong" is worse off than one whose audio needed a sweep afterwards.
     *
     * @return how many stored objects were removed
     */
    @Transactional
    public int eraseAccount(String userId) {
        List<Meeting> owned = meetings.findByUserIdOrderByCreatedAtDesc(userId);
        int objects = 0;
        for (Meeting meeting : owned) {
            if (meeting.getObjectKey() != null) {
                storage.delete(meeting.getObjectKey());
                objects++;
            }
        }
        // Written before the row it refers to disappears; the log itself cascades
        // with it, which is the point — an audit trail that outlived the account
        // it describes would be the one record erasure did not reach.
        audit.record(userId, "ACCOUNT_ERASED", "user", userId);
        users.findById(userId).ifPresent(users::delete);
        return objects;
    }

    /* ------------------------------- helpers -------------------------------- */

    private Meeting require(String userId, String meetingId) {
        return meetings.findByIdAndUserId(meetingId, userId)
                .orElseThrow(() -> ApiException.notFound("Meeting not found"));
    }
}
