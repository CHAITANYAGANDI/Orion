package com.orion.dto;

import com.orion.domain.MeetingStatus;

public record ReprocessResponse(
        String meetingId,
        MeetingStatus status
) {
}
