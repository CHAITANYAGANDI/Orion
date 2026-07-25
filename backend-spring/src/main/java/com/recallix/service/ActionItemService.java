package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.dto.ActionItemPatchRequest;
import com.recallix.dto.ActionItemResponse;
import com.recallix.dto.PageResponse;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingActionItem;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingRepository;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/** Action-item queries and updates, always scoped to the owning user. */
@Service
public class ActionItemService {

    private static final Set<String> VALID_PRIORITIES = Set.of("high", "medium", "low");
    private static final Set<String> VALID_STATUSES = Set.of("OPEN", "IN_PROGRESS", "DONE");

    private final MeetingActionItemRepository actionItems;
    private final MeetingRepository meetings;

    public ActionItemService(MeetingActionItemRepository actionItems, MeetingRepository meetings) {
        this.actionItems = actionItems;
        this.meetings = meetings;
    }

    @Transactional(readOnly = true)
    public List<ActionItemResponse> listForMeeting(String userId, String meetingId) {
        Meeting meeting = meetings.findByIdAndUserId(meetingId, userId)
                .orElseThrow(() -> ApiException.notFound("Meeting not found"));
        return actionItems.findByMeetingId(meetingId).stream()
                .map(a -> ActionItemResponse.from(a, meeting.getTitle()))
                .toList();
    }

    @Transactional(readOnly = true)
    public PageResponse<ActionItemResponse> list(String userId, int page, int size,
                                                 String status, String priority) {
        Page<MeetingActionItem> result = actionItems.findForUser(
                userId, blankToNull(status), blankToNull(priority), PageRequest.of(page, size));
        Map<String, String> titles = titlesFor(result.getContent());
        List<ActionItemResponse> content = result.getContent().stream()
                .map(a -> ActionItemResponse.from(a, titles.get(a.getMeetingId())))
                .toList();
        return PageResponse.from(result, content);
    }

    @Transactional
    public ActionItemResponse patch(String userId, String id, ActionItemPatchRequest req) {
        MeetingActionItem item = actionItems.findByIdForUser(id, userId)
                .orElseThrow(() -> ApiException.notFound("Action item not found"));

        if (req.ownerName() != null) {
            item.setOwnerName(req.ownerName());
        }
        if (req.dueDate() != null) {
            item.setDueDate(req.dueDate());
        }
        if (req.priority() != null) {
            String p = req.priority().toLowerCase();
            if (!VALID_PRIORITIES.contains(p)) {
                throw ApiException.badRequest("priority must be one of " + VALID_PRIORITIES);
            }
            item.setPriority(p);
        }
        if (req.status() != null) {
            String s = req.status().toUpperCase();
            if (!VALID_STATUSES.contains(s)) {
                throw ApiException.badRequest("status must be one of " + VALID_STATUSES);
            }
            item.setStatus(s);
        }
        String title = meetings.findById(item.getMeetingId()).map(Meeting::getTitle).orElse(null);
        return ActionItemResponse.from(item, title);
    }

    private Map<String, String> titlesFor(List<MeetingActionItem> items) {
        Set<String> ids = items.stream().map(MeetingActionItem::getMeetingId).collect(Collectors.toSet());
        return meetings.findAllById(ids).stream()
                .collect(Collectors.toMap(Meeting::getId, Meeting::getTitle, (a, b) -> a));
    }

    private static String blankToNull(String s) {
        return (s == null || s.isBlank()) ? null : s;
    }
}
