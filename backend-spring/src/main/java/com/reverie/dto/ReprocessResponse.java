package com.reverie.dto;

import com.reverie.domain.MeetingStatus;

public record ReprocessResponse(
        String meetingId,
        MeetingStatus status
) {
}
