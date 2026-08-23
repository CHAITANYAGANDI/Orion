package com.recallix.dto;

import com.recallix.entity.SpeakerProfile;

import java.time.Instant;

/**
 * One named voice, as Settings shows it.
 *
 * <p>Name, how many appearances built it, and when. Notably <b>not</b> the
 * embedding — see {@link SpeakerProfile} for why that column is not even mapped.
 * There is nothing useful a user could do with 192 floats and a great deal that
 * could go wrong with putting them on the wire.
 */
public record SpeakerProfileResponse(
        String id,
        String name,
        /** How many separately-named appearances have been averaged into it. */
        int samples,
        Instant createdAt,
        Instant updatedAt
) {
    public static SpeakerProfileResponse from(SpeakerProfile profile) {
        return new SpeakerProfileResponse(
                profile.getId(),
                profile.getDisplayName(),
                profile.getSampleCount(),
                profile.getCreatedAt(),
                profile.getUpdatedAt());
    }
}
