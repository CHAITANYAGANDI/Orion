package com.orion.dto;

import jakarta.validation.constraints.Size;

/**
 * PATCH /api/v1/action-items/{id} — all fields optional (null = unchanged).
 *
 * <p>{@code dueDate} is the exception to "null means unchanged": an empty string
 * clears it. Without that there is no way back from a date the extractor got
 * wrong, and null cannot mean both "leave it" and "remove it".
 *
 * <p>Any change here marks the item as edited, which is what keeps a reprocess
 * from undoing it — see {@link com.orion.entity.MeetingActionItem}.
 */
public record ActionItemPatchRequest(
        @Size(max = 500) String title,
        @Size(max = 200) String ownerName,
        @Size(max = 40) String dueDate,
        String status
) {
}
