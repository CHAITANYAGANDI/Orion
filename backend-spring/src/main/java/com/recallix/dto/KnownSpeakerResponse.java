package com.recallix.dto;

import com.recallix.entity.KnownSpeaker;

import java.time.Instant;

public record KnownSpeakerResponse(
        String id,
        String displayName,
        int timesUsed,
        Instant lastUsedAt
) {
    public static KnownSpeakerResponse from(KnownSpeaker speaker) {
        return new KnownSpeakerResponse(
                speaker.getId(),
                speaker.getDisplayName(),
                speaker.getTimesUsed(),
                speaker.getLastUsedAt());
    }
}
