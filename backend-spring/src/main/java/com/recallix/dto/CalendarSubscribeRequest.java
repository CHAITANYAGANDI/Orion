package com.recallix.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** Subscribe to a calendar's iCal (ICS) feed. */
public record CalendarSubscribeRequest(
        @NotBlank(message = "A calendar URL is required")
        @Size(max = 2048, message = "That URL is too long")
        String url,
        @Size(max = 120, message = "That label is too long")
        String label
) {
    public String trimmedUrl() {
        return url == null ? "" : url.trim();
    }
}
