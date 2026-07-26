package com.recallix.dto;

import com.recallix.entity.MeetingShare;

import java.time.Instant;

/** The owner's view of a share link — the URL plus how it has been used. */
public record ShareResponse(
        String token,
        /** Absolute link, safe to copy straight into an email. */
        String url,
        boolean includeTranscript,
        Instant expiresAt,
        int viewCount,
        Instant lastViewedAt,
        Instant createdAt
) {
    public static ShareResponse from(MeetingShare share, String baseUrl) {
        return new ShareResponse(
                share.getToken(),
                baseUrl + "/shared/" + share.getToken(),
                share.isIncludeTranscript(),
                share.getExpiresAt(),
                share.getViewCount(),
                share.getLastViewedAt(),
                share.getCreatedAt());
    }
}
