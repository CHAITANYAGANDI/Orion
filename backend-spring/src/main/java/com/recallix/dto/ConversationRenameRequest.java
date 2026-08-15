package com.recallix.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Renaming a chat thread.
 *
 * <p>Titles are generated from the first question, which is a guess. Renaming
 * is what makes a history list worth keeping — a thread nobody can label is one
 * nobody can find again, and the fallback is scrolling every conversation.
 */
public record ConversationRenameRequest(
        @NotBlank @Size(max = 200) String title
) {
}
