package com.recallix.dto;

import jakarta.validation.constraints.NotBlank;

/** POST /api/v1/meetings/{id}/translate */
public record TranslateRequest(
        @NotBlank String targetLanguage
) {
}
