package com.recallix.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Adding or editing a decision or risk by hand.
 *
 * <p>{@code kind} is required when adding and ignored when editing: changing a
 * decision into a risk is not an edit, it is a different row, and allowing it
 * would let a correction to a decision quietly leave the decision record.
 */
public record InsightRequest(
        String kind,
        @NotBlank @Size(max = 2000) String text
) {
    public String normalizedKind() {
        String k = kind == null ? "" : kind.trim().toUpperCase();
        return "RISK".equals(k) ? "RISK" : "DECISION";
    }
}
