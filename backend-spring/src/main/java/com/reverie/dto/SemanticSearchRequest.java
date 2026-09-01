package com.reverie.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** A meaning-based search over the user's transcripts. */
public record SemanticSearchRequest(
        @NotBlank @Size(max = 500) String query,
        @Min(1) @Max(50) Integer limit
) {
}
