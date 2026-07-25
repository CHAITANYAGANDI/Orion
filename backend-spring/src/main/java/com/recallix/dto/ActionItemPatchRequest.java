package com.recallix.dto;

/** PATCH /api/v1/action-items/{id} — all fields optional (null = unchanged). */
public record ActionItemPatchRequest(
        String ownerName,
        String dueDate,
        String priority,
        String status
) {
}
