package com.recallix.dto;

import com.recallix.entity.MeetingActionItem;

import java.time.Instant;

/** Spring-side action item — exposes `title` (NOT the AI-side `taskTitle`). */
public record ActionItemResponse(
        String id,
        String meetingId,
        String meetingTitle,
        String title,
        String ownerName,
        String dueDate,
        String priority,
        String status,
        String sourceSentence,
        Instant createdAt
) {
    public static ActionItemResponse from(MeetingActionItem a, String meetingTitle) {
        return new ActionItemResponse(
                a.getId(),
                a.getMeetingId(),
                meetingTitle,
                a.getTitle(),
                a.getOwnerName(),
                a.getDueDate(),
                a.getPriority(),
                a.getStatus(),
                a.getSourceSentence(),
                a.getCreatedAt()
        );
    }
}
