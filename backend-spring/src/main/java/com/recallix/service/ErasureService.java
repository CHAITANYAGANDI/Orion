package com.recallix.service;

import com.recallix.common.ApiException;
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
                          SpeakerIdentityService speakerIdentity) {
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
     * "delete this" when it is already gone is yes.
     */
    @Transactional
    public Instant eraseAudio(String userId, String meetingId) {
        Meeting meeting = require(userId, meetingId);
        Instant at = eraseAudio(meeting);
        audit.record(userId, "MEETING_AUDIO_ERASED", "meeting", meetingId);
        return at;
    }

    /** The same, for a meeting already loaded and already known to be the caller's. */
    Instant eraseAudio(Meeting meeting) {
        if (meeting.getAudioDeletedAt() != null) {
            return meeting.getAudioDeletedAt();
        }
        storage.delete(meeting.getObjectKey());
        meeting.setObjectKey(null);
        // A YouTube import keeps its source URL — that is where the audio came
        // from, not a copy we hold — but the player must stop offering it, or
        // "the recording is deleted" is a claim the page immediately contradicts.
        meeting.setAudioUrl(null);
        meeting.setAudioDeletedAt(Instant.now());

        // And the voiceprints computed from it. An ECAPA embedding is not audio
        // and cannot be turned back into audio, so it is tempting to argue it
        // survives a request to delete the recording. It should not: it is a
        // durable identifier derived from the voices on that recording, and it
        // is the specific thing that makes those voices findable again. Keeping
        // it would answer "delete the recording of me" with a technicality.
        //
        // Named profiles are untouched. Those were created by a separate,
        // explicit act about a person, not about this file, and they are what
        // the account holder switched the feature on for.
        speakerIdentity.forgetMeeting(meeting.getUserId(), meeting.getId());

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
        transcripts.deleteByMeetingId(meetingId);
        segments.deleteByMeetingId(meetingId);
        moments.deleteByMeetingId(meetingId);
        translations.deleteByMeetingId(meetingId);
        try {
            chunks.deleteByMeetingId(meetingId);
        } catch (Exception e) {
            // Loud, and not fatal to the rest: the transcript still goes. But
            // this is the one leftover that can still speak, so it is an error
            // rather than a shrug.
            log.error("Transcript erased for {} but its embeddings survived — chat may still quote it: {}",
                    meetingId, e.toString());
        }
        meeting.setTranscriptDeletedAt(Instant.now());

        return meeting.getTranscriptDeletedAt();
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
