package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.common.IdGenerator;
import com.recallix.dto.InsightRequest;
import com.recallix.dto.InsightResponse;
import com.recallix.entity.MeetingInsight;
import com.recallix.repository.MeetingInsightRepository;
import com.recallix.repository.MeetingRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;

/**
 * Reading and correcting a meeting's decisions and risks.
 *
 * <p>These rows are generated, and they feed workspace chat as the record of
 * what was settled — so a wrong one is not cosmetic, it is a wrong answer to
 * "does this conflict with what we decided in March?". Being able to fix them
 * is what makes them safe to use that way.
 */
@Service
public class InsightService {

    private final MeetingInsightRepository insights;
    private final MeetingRepository meetings;
    private final AuditService audit;

    public InsightService(MeetingInsightRepository insights,
                          MeetingRepository meetings,
                          AuditService audit) {
        this.insights = insights;
        this.meetings = meetings;
        this.audit = audit;
    }

    @Transactional(readOnly = true)
    public List<InsightResponse> list(String userId, String meetingId) {
        requireOwnedMeeting(userId, meetingId);
        return insights.findByMeetingIdOrderByCreatedAt(meetingId).stream()
                .map(InsightResponse::from)
                .toList();
    }

    @Transactional
    public InsightResponse add(String userId, String meetingId, InsightRequest req) {
        requireOwnedMeeting(userId, meetingId);

        MeetingInsight e = new MeetingInsight();
        e.setId(IdGenerator.insight());
        e.setMeetingId(meetingId);
        e.setUserId(userId);
        e.setKind(req.normalizedKind());
        e.setText(req.text().trim());
        // No section: nobody read this out of the summary, a person typed it.
        e.setSourceSection("");
        // Marks it as human-owned, which is what stops the next reprocess from
        // deleting it.
        e.setEdited(true);
        insights.save(e);

        audit.record(userId, "INSIGHT_ADDED", "meeting", meetingId);
        return InsightResponse.from(e);
    }

    @Transactional
    public InsightResponse update(String userId, String insightId, InsightRequest req) {
        MeetingInsight e = owned(userId, insightId);
        e.setText(req.text().trim());
        // Kind deliberately not updated: see InsightRequest.
        e.setEdited(true);
        e.setUpdatedAt(Instant.now());

        audit.record(userId, "INSIGHT_UPDATED", "meeting", e.getMeetingId());
        return InsightResponse.from(e);
    }

    @Transactional
    public void delete(String userId, String insightId) {
        MeetingInsight e = owned(userId, insightId);
        String meetingId = e.getMeetingId();
        insights.delete(e);
        audit.record(userId, "INSIGHT_DELETED", "meeting", meetingId);
    }

    // --- helpers ------------------------------------------------------------ //

    private MeetingInsight owned(String userId, String insightId) {
        MeetingInsight e = insights.findById(insightId)
                .orElseThrow(() -> ApiException.notFound("Not found"));
        // Checked in the application layer as well as by RLS: the same message
        // for "someone else's" and "does not exist" so neither confirms the
        // other user's row exists.
        if (!userId.equals(e.getUserId())) {
            throw ApiException.notFound("Not found");
        }
        return e;
    }

    private void requireOwnedMeeting(String userId, String meetingId) {
        meetings.findByIdAndUserId(meetingId, userId)
                .orElseThrow(() -> ApiException.notFound("Meeting not found"));
    }
}
