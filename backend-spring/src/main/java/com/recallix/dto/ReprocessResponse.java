package com.recallix.dto;

import com.recallix.domain.MeetingStatus;

public record ReprocessResponse(
        String meetingId,
        MeetingStatus status
) {
}
