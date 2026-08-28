package com.orion.dto;

import jakarta.validation.constraints.NotBlank;

/**
 * POST /api/v1/meetings/{id}/summary — rewrite the notes under another template.
 *
 * <p>The slug is required rather than defaulting to General: this endpoint
 * exists because the user picked something, and a request that silently means
 * "General" is far more likely to be a client bug than an intention.
 */
public record ResummarizeRequest(
        @NotBlank(message = "Pick a template") String template
) {
}
