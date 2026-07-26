package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.dto.EmailDraftResponse;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingSummary;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingDecisionRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingSummaryRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * Drafts the recap email for a meeting.
 *
 * <p>Assembles the brief here rather than sending the transcript, so the draft is
 * grounded in what was already extracted and reviewed. A follow-up that invents a
 * commitment is worse than none — the sender forwards it without re-reading.
 */
@Service
public class FollowUpService {

    private final MeetingRepository meetings;
    private final MeetingSummaryRepository summaries;
    private final MeetingDecisionRepository decisions;
    private final MeetingActionItemRepository actionItems;
    private final AiClient ai;

    public FollowUpService(MeetingRepository meetings,
                           MeetingSummaryRepository summaries,
                           MeetingDecisionRepository decisions,
                           MeetingActionItemRepository actionItems,
                           AiClient ai) {
        this.meetings = meetings;
        this.summaries = summaries;
        this.decisions = decisions;
        this.actionItems = actionItems;
        this.ai = ai;
    }

    @Transactional(readOnly = true)
    public EmailDraftResponse draft(String userId, String meetingId) {
        Meeting meeting = meetings.findByIdAndUserId(meetingId, userId)
                .orElseThrow(() -> ApiException.notFound("Meeting not found"));

        MeetingSummary summary = summaries
                .findFirstByMeetingIdOrderByCreatedAtDesc(meetingId)
                .orElse(null);

        List<String> decisionTexts = decisions.findByMeetingId(meetingId).stream()
                .map(d -> d.getDecisionText())
                .filter(t -> t != null && !t.isBlank())
                .toList();

        // Owner and due date matter in a recap — "Priya: ship the consumer (Wed)"
        // is actionable in a way the bare title is not.
        List<String> actionTexts = actionItems.findByMeetingId(meetingId).stream()
                .map(FollowUpService::describeAction)
                .filter(t -> !t.isBlank())
                .toList();

        if (summary == null && decisionTexts.isEmpty() && actionTexts.isEmpty()) {
            throw ApiException.badRequest("This meeting has no brief to draft from yet");
        }

        AiClient.EmailDraft draft = ai.draftEmail(
                meeting.getTitle(),
                summary == null ? "" : summary.getShortSummary(),
                summary == null ? List.of() : summary.getKeyPoints(),
                decisionTexts,
                actionTexts);

        return new EmailDraftResponse(draft.subject(), draft.body());
    }

    private static String describeAction(com.recallix.entity.MeetingActionItem a) {
        String title = a.getTitle() == null ? "" : a.getTitle().trim();
        if (title.isBlank()) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        if (a.getOwnerName() != null && !a.getOwnerName().isBlank()) {
            sb.append(a.getOwnerName().trim()).append(": ");
        }
        sb.append(title);
        if (a.getDueDate() != null && !a.getDueDate().isBlank()) {
            sb.append(" (due ").append(a.getDueDate().trim()).append(")");
        }
        return sb.toString();
    }
}
