package com.recallix.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.util.List;

/**
 * Import a meeting from a URL rather than an upload.
 *
 * <p>Only YouTube links are accepted today. The title is optional — when it is
 * omitted the worker backfills it from the video's own metadata, which is
 * almost always better than anything the user would type.
 */
public record MeetingImportRequest(
        @NotBlank(message = "A URL is required")
        @Size(max = 2048, message = "That URL is too long")
        String url,
        String title,
        List<String> tags
) {
    public String trimmedUrl() {
        return url == null ? "" : url.trim();
    }

    public List<String> tagsOrEmpty() {
        return tags == null ? List.of() : tags;
    }
}
