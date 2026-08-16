package com.recallix.dto;

import com.recallix.domain.DueStatus;
import com.recallix.entity.MeetingActionItem;

import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;

/**
 * Spring-side action item — exposes `title` (NOT the AI-side `taskTitle`).
 *
 * <p>The deadline arrives three ways and all three are needed. {@code dueDate}
 * is what was said and is what the row displays; {@code dueOn} is that read as a
 * date and may be absent when it could not be; {@code dueStatus} and
 * {@code daysUntilDue} are the comparison against today, made here so that the
 * badge, the filter and the reminder email cannot disagree about what "overdue"
 * means. See {@link DueStatus}.
 */
public record ActionItemResponse(
        String id,
        String meetingId,
        String meetingTitle,
        String title,
        String ownerName,
        /** The deadline in the words it was given in. */
        String dueDate,
        /** That deadline as a date, or null when the phrasing had no single reading. */
        LocalDate dueOn,
        DueStatus dueStatus,
        /** Negative when overdue, 0 today, null when there is no resolved date. */
        Integer daysUntilDue,
        String priority,
        String status,
        String sourceSentence,
        /** Where the source sentence sits in the recording, when it could be located. */
        Double sourceStartSeconds,
        Instant completedAt,
        /** A person has changed this row, so a reprocess will leave it alone. */
        boolean edited,
        int commentCount,
        Instant createdAt,
        Instant updatedAt
) {
    public static ActionItemResponse from(MeetingActionItem a, String meetingTitle,
                                          LocalDate today, int commentCount) {
        LocalDate dueOn = a.getDueOn();
        return new ActionItemResponse(
                a.getId(),
                a.getMeetingId(),
                meetingTitle,
                a.getTitle(),
                a.getOwnerName(),
                a.getDueDate(),
                dueOn,
                DueStatus.of(dueOn, today, a.isDone()),
                dueOn == null ? null : (int) ChronoUnit.DAYS.between(today, dueOn),
                a.getPriority(),
                a.getStatus(),
                a.getSourceSentence(),
                a.getSourceStartSeconds(),
                a.getCompletedAt(),
                a.isEdited(),
                commentCount,
                a.getCreatedAt(),
                a.getUpdatedAt()
        );
    }
}
