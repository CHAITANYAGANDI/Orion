package com.recallix.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Adding an action item to a meeting by hand.
 *
 * <p>Until now action items only ever arrived from the extraction pass, which
 * meant the one thing a reader is most likely to notice — a commitment the
 * model missed — was the one thing they could not record. This is the path for
 * "I just read the sentence where they promised it".
 *
 * <p>{@code sourceSentence} carries the transcript line it came from, the same
 * field the extractor fills, so a hand-added item is evidenced the same way as
 * a generated one and the list does not need to distinguish them.
 */
public record ActionItemCreateRequest(
        @NotBlank @Size(max = 500) String title,
        @Size(max = 200) String ownerName,
        /** ISO date, or null. Stored as text like the extractor's output. */
        @Size(max = 40) String dueDate,
        String priority,
        @Size(max = 2000) String sourceSentence
) {
}
