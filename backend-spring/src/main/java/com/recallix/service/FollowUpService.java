package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.dto.EmailDraftResponse;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingSummary;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingSummaryRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * Writes the recap email for a meeting.
 *
 * <p>Not called by any endpoint. It used to back
 * {@code POST /meetings/{id}/follow-up-email} — draft me the email, on
 * demand — and that is gone; {@link RecapEmailService} is the only caller
 * left, which is the one place a draft is actually sent rather than handed back
 * for somebody to paste.
 *
 * <p>Grounded in what was already extracted and reviewed. A follow-up that
 * invents a commitment is worse than no follow-up at all, because the user
 * forwards it.
 */
@Service
public class FollowUpService {

    private final MeetingRepository meetings;
    private final MeetingSummaryRepository summaries;
    private final MeetingActionItemRepository actionItems;
    private final AiClient ai;

    public FollowUpService(MeetingRepository meetings,
                           MeetingSummaryRepository summaries,
                           MeetingActionItemRepository actionItems,
                           AiClient ai) {
        this.meetings = meetings;
        this.summaries = summaries;
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


        // Owner and due date matter in a recap — "Priya: ship the consumer (Wed)"
        // is actionable in a way the bare title is not.
        List<String> actionTexts = actionItems.findByMeetingId(meetingId).stream()
                .map(FollowUpService::describeAction)
                .filter(t -> !t.isBlank())
                .toList();

        if (summary == null && actionTexts.isEmpty()) {
            throw ApiException.badRequest("This meeting has no brief to draft from yet");
        }

        AiClient.EmailDraft draft = ai.draftEmail(
                meeting.getTitle(),
                summary == null ? "" : summary.getShortSummary(),
                summary == null ? List.of() : summary.getKeyPoints(),
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
