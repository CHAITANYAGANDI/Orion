package com.recallix.dto;

import java.util.List;

/**
 * Everything the settings page needs to say about voice identification.
 *
 * <p>The switch, and the list of what is currently held under it. The list is
 * the important half: a consent control that does not show you what you
 * consented to is a checkbox, not a control, and the whole point of naming this
 * data biometric-adjacent is that the person it describes can see it and remove
 * it. Each entry is a name and a count — never an embedding, which is not on
 * the entity at all.
 */
public record SpeakerSettingsResponse(
        boolean learningEnabled,
        List<SpeakerProfileResponse> profiles
) {
}
