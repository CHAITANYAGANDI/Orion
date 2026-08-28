package com.orion.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** One entry in a task's working log. */
public record ActionItemCommentRequest(
        @NotBlank(message = "Write something first")
        @Size(max = 4000, message = "That comment is too long")
        String body
) {
}
