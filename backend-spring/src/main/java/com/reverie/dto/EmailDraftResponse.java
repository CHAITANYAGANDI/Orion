package com.reverie.dto;

/** A ready-to-send follow-up email, drafted from a meeting's brief. */
public record EmailDraftResponse(
        String subject,
        String body
) {
}
