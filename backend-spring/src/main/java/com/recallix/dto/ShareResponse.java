package com.recallix.dto;

import com.recallix.entity.MeetingShare;

import java.time.Instant;

/**
 * The owner's view of a share link — the URL, what it reveals, and how it has
 * been used.
 *
 * <p>{@code passwordProtected} is a boolean and never the hash. The owner does
 * not need their own password back, and returning it would put it in a response
 * body, a browser cache and a devtools log for no benefit; a link whose password
 * has been forgotten is replaced rather than recovered.
 */
public record ShareResponse(
        String id,
        String token,
        /** Absolute link, safe to copy straight into an email. */
        String url,
        String label,

        boolean includeSummary,
        boolean includeActionItems,
        boolean includeTranscript,
        boolean includeAudio,

        boolean passwordProtected,
        Instant expiresAt,

        /** Null for a whole-meeting link; set for an excerpt. */
        Double startSeconds,
        Double endSeconds,
        String quote,

        int viewCount,
        Instant lastViewedAt,
        Instant createdAt
) {
    public static ShareResponse from(MeetingShare share, String baseUrl) {
        return new ShareResponse(
                share.getId(),
                share.getToken(),
                baseUrl + "/shared/" + share.getToken(),
                share.getLabel(),
                share.isIncludeSummary(),
                share.isIncludeActionItems(),
                share.isIncludeTranscript(),
                share.isIncludeAudio(),
                share.isPasswordProtected(),
                share.getExpiresAt(),
                share.getStartSeconds(),
                share.getEndSeconds(),
                share.getQuote(),
                share.getViewCount(),
                share.getLastViewedAt(),
                share.getCreatedAt());
    }
}
