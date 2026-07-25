package com.recallix.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record ChatAskRequest(
        @NotBlank @Size(max = 2000) String question
) {
}
