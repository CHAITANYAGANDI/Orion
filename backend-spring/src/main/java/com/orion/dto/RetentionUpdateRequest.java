package com.orion.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;

/**
 * PATCH /api/v1/privacy/retention.
 *
 * <p>Both fields are sent every time and null means "keep forever" rather than
 * "leave this one alone" — the opposite of every other patch in the API, and
 * deliberately so. The two dials are on screen together, they constrain each
 * other, and a partial update from a stale render is how somebody ends up with
 * a recording rule they did not set. There are two of them; sending both costs
 * nothing.
 */
public record RetentionUpdateRequest(
        /** Days to keep recordings. Null keeps them indefinitely. */
        @Min(1) @Max(3650) Integer audioDays,
        /** Days to keep whole meetings. Null keeps them indefinitely. */
        @Min(1) @Max(3650) Integer meetingDays
) {
}
