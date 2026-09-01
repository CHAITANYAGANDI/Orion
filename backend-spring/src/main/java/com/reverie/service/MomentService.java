package com.reverie.service;

import com.reverie.common.ApiException;
import com.reverie.common.IdGenerator;
import com.reverie.domain.MomentRange;
import com.reverie.dto.MomentRequest;
import com.reverie.dto.MomentResponse;
import com.reverie.entity.TranscriptMoment;
import com.reverie.repository.MeetingRepository;
import com.reverie.repository.TranscriptMomentRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;

/**
 * Highlights, bookmarks, notes and reactions on a transcript.
 *
 * <p>Everything here is user-authored, so unlike the derived stores there is no
 * regeneration path and no {@code edited} flag: nothing else ever writes these
 * rows, and nothing else may delete them.
 */
@Service
public class MomentService {

    /**
     * Per meeting. Not a licensing limit — a guard against a runaway client
     * turning a transcript into tens of thousands of rows that then have to be
     * resolved against the text on every page load.
     */
    static final int MAX_PER_MEETING = 2000;

    /** Matches the CHECK constraints in V27, so a too-long body is a 400 with a
     *  usable message rather than a 500 from the database. */
    private static final int MAX_TEXT = 5000;

    /**
     * Ranges per moment. A selection spanning more than this many utterances is
     * not a passage somebody meant to mark; it is a select-all.
     */
    private static final int MAX_RANGES = 200;

    /**
     * Code points in a reaction's body.
     *
     * <p>Generous on purpose. One emoji is one grapheme to a reader and
     * anywhere from one to about ten code points to a computer — a flag is
     * two, a skin-toned gesture is three, and "family with two children" is
     * seven joined by zero-width joiners. This is loose enough for all of
     * those and tight enough that the field cannot become a second note.
     */
    private static final int MAX_REACTION_CODEPOINTS = 16;

    private final TranscriptMomentRepository moments;
    private final MeetingRepository meetings;
    private final AuditService audit;

    public MomentService(TranscriptMomentRepository moments,
                         MeetingRepository meetings,
                         AuditService audit) {
        this.moments = moments;
        this.meetings = meetings;
        this.audit = audit;
    }

    @Transactional(readOnly = true)
    public List<MomentResponse> list(String userId, String meetingId) {
        requireOwnedMeeting(userId, meetingId);
        return moments.findByMeetingIdOrderByStartSecondsAscCreatedAtAsc(meetingId).stream()
                .map(MomentResponse::from)
                .toList();
    }

    @Transactional
    public MomentResponse add(String userId, String meetingId, MomentRequest req) {
        requireOwnedMeeting(userId, meetingId);
        if (moments.countByMeetingId(meetingId) >= MAX_PER_MEETING) {
            throw ApiException.badRequest(
                    "This meeting already has " + MAX_PER_MEETING + " marks. Delete some first.");
        }

        String kind = req.normalizedKind();
        List<MomentRange> ranges = cleanRanges(req.ranges());
        String quote = trimmed(req.quote());
        String body = trimmed(req.body());

        // The shapes that cannot be drawn or read. Checked here rather than
        // left to the CHECK constraints so the client gets a message it can show.
        if ("HIGHLIGHT".equals(kind) && quote.isEmpty()) {
            throw ApiException.badRequest("A highlight needs some selected text.");
        }
        if ("NOTE".equals(kind) && body.isEmpty()) {
            throw ApiException.badRequest("A note needs something written in it.");
        }
        if ("REACTION".equals(kind)) {
            if (body.isEmpty()) {
                throw ApiException.badRequest("A reaction needs an emoji.");
            }
            if (body.codePointCount(0, body.length()) > MAX_REACTION_CODEPOINTS) {
                // Counted in code points, not in chars: a single emoji is
                // routinely two (a surrogate pair) and a flag or a skin-toned
                // one is more, so a char limit would reject the very
                // characters this is for.
                throw ApiException.badRequest("A reaction is a single emoji.");
            }
            // Reacting is a toggle in the UI, so arriving here twice with the
            // same emoji on the same turn means two clicks raced, or two tabs
            // are open. Returning what is already there makes the second one a
            // no-op rather than a unique-constraint failure the user reads as
            // "reacting is broken". Only reactions: two notes on one sentence
            // are two notes.
            double at = req.startSeconds() == null ? 0 : Math.max(0, req.startSeconds());
            var existing = moments.findFirstByMeetingIdAndUserIdAndKindAndStartSecondsAndBody(
                    meetingId, userId, kind, at, body);
            if (existing.isPresent()) {
                return MomentResponse.from(existing.get());
            }
        }

        TranscriptMoment m = new TranscriptMoment();
        m.setId(IdGenerator.moment());
        m.setMeetingId(meetingId);
        m.setUserId(userId);
        m.setKind(kind);
        m.setRanges(ranges);
        m.setQuote(quote);
        m.setBody(body);
        m.setSpeaker(trimmed(req.speaker()));
        double start = req.startSeconds() == null ? 0 : Math.max(0, req.startSeconds());
        // An end before its start would sort correctly and render as a
        // zero-width span, which looks like a lost highlight rather than a bad
        // request. Clamping keeps the row usable.
        m.setStartSeconds(start);
        m.setEndSeconds(Math.max(start, req.endSeconds() == null ? start : req.endSeconds()));
        moments.save(m);

        audit.record(userId, "MOMENT_ADDED", "meeting", meetingId);
        return MomentResponse.from(m);
    }

    /**
     * Edit the body — a note's text, a bookmark's label, or a reaction's emoji.
     *
     * <p>The anchor is deliberately not editable. Re-pointing a note at a
     * different passage is a new note; allowing it in place would leave a
     * comment attached to words nobody wrote it about.
     */
    @Transactional
    public MomentResponse updateBody(String userId, String momentId, MomentRequest req) {
        TranscriptMoment m = owned(userId, momentId);
        String body = trimmed(req.body());
        if ("NOTE".equals(m.getKind()) && body.isEmpty()) {
            throw ApiException.badRequest("A note needs something written in it.");
        }
        // A reaction *is* its body, so emptying it would leave a mark with
        // nothing to draw. Changing one emoji for another is allowed: it is the
        // same gesture on the same passage, reconsidered.
        if ("REACTION".equals(m.getKind()) && body.isEmpty()) {
            throw ApiException.badRequest("A reaction needs an emoji.");
        }
        m.setBody(body);
        m.setUpdatedAt(Instant.now());

        audit.record(userId, "MOMENT_UPDATED", "meeting", m.getMeetingId());
        return MomentResponse.from(m);
    }

    @Transactional
    public void delete(String userId, String momentId) {
        TranscriptMoment m = owned(userId, momentId);
        String meetingId = m.getMeetingId();
        moments.delete(m);
        audit.record(userId, "MOMENT_DELETED", "meeting", meetingId);
    }

    // --- helpers ------------------------------------------------------------ //

    /**
     * Drop ranges that cannot anchor anything.
     *
     * <p>A range with no segment id and no quote has neither anchor, so it can
     * never be resolved back onto the transcript; keeping it would put an
     * invisible fragment in a highlight that silently covers less than the user
     * selected. Negative offsets are clamped rather than rejected — they come
     * from a client that measured badly, and the quote will still find the
     * passage.
     */
    private static List<MomentRange> cleanRanges(List<MomentRange> raw) {
        if (raw == null || raw.isEmpty()) {
            return List.of();
        }
        return raw.stream()
                .filter(r -> r != null)
                .filter(r -> notBlank(r.segmentId()) || notBlank(r.quote()))
                .limit(MAX_RANGES)
                .map(r -> new MomentRange(
                        trimmed(r.segmentId()),
                        Math.max(0, r.startOffset()),
                        Math.max(0, r.endOffset()),
                        truncate(r.quote())))
                .toList();
    }

    private static boolean notBlank(String s) {
        return s != null && !s.isBlank();
    }

    private static String trimmed(String s) {
        return s == null ? "" : truncate(s.trim());
    }

    private static String truncate(String s) {
        if (s == null) {
            return "";
        }
        return s.length() <= MAX_TEXT ? s : s.substring(0, MAX_TEXT);
    }

    private TranscriptMoment owned(String userId, String momentId) {
        TranscriptMoment m = moments.findById(momentId)
                .orElseThrow(() -> ApiException.notFound("Not found"));
        // Checked in the application layer as well as by RLS, and with the same
        // message for "someone else's" and "does not exist" so neither confirms
        // the other row exists.
        if (!userId.equals(m.getUserId())) {
            throw ApiException.notFound("Not found");
        }
        return m;
    }

    private void requireOwnedMeeting(String userId, String meetingId) {
        meetings.findByIdAndUserId(meetingId, userId)
                .orElseThrow(() -> ApiException.notFound("Meeting not found"));
    }
}
