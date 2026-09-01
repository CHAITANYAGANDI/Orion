package com.reverie.dto;

import jakarta.validation.constraints.NotNull;

import java.util.Map;

/** PATCH /api/v1/meetings/{id}/speakers — { "S1": "Alice", "S2": "Bob" }. */
public record SpeakerRenameRequest(
        @NotNull Map<String, String> mapping
) {
}
