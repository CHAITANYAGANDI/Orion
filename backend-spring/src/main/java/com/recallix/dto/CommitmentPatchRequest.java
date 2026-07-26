package com.recallix.dto;

import jakarta.validation.constraints.NotBlank;

/** Manual override of an inferred commitment status. */
public record CommitmentPatchRequest(
        @NotBlank String status
) {
}
