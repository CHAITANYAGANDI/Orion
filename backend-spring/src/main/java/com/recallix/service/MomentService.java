package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.common.IdGenerator;
import com.recallix.domain.MomentRange;
import com.recallix.dto.MomentRequest;
import com.recallix.dto.MomentResponse;
import com.recallix.entity.TranscriptMoment;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.TranscriptMomentRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;

/**
 * Highlights, bookmarks and notes on a transcript.
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

        // The two shapes that cannot be drawn or read. Checked here rather than
        // left to the CHECK constraints so the client gets a message it can show.
        if ("HIGHLIGHT".equals(kind) && quote.isEmpty()) {
            throw ApiException.badRequest("A highlight needs some selected text.");
        }
        if ("NOTE".equals(kind) && body.isEmpty()) {
            throw ApiException.badRequest("A note needs something written in it.");
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
     * Edit the body — a note's text, or a bookmark's label.
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
