package com.reverie.dto;

import jakarta.validation.constraints.Size;

import java.util.List;

/**
 * PATCH /api/v1/meetings/{id} — rename a meeting, or change its tags.
 *
 * <p>This is where meeting metadata is edited now that uploading asks for none
 * of it. Both fields are independently optional and null means "leave alone",
 * so renaming cannot silently clear someone's tags.
 *
 * <p>The distinction matters for tags in particular: {@code null} leaves them,
 * an empty list clears them. Without that, "remove my last tag" would be
 * impossible to express.
 */
public record MeetingUpdateRequest(
        @Size(max = 500, message = "Title is too long") String title,
        List<String> tags
) {
    /** Trimmed title, or null when the caller isn't renaming. */
    public String titleOrNull() {
        return title == null || title.isBlank() ? null : title.trim();
    }

    /** Null when the caller isn't touching tags; otherwise the cleaned list. */
    public List<String> tagsOrNull() {
        if (tags == null) {
            return null;
        }
        return tags.stream()
                .filter(t -> t != null && !t.isBlank())
                .map(String::trim)
                .distinct()
                .limit(20)
                .toList();
    }
}
