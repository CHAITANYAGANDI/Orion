package com.recallix.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;

/**
 * Options for a share link. Both fields are optional — the default is a
 * non-expiring link with the summary but not the verbatim transcript.
 */
public record ShareCreateRequest(
        Boolean includeTranscript,
        @Min(1) @Max(365) Integer expiresInDays
) {
}
