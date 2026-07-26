package com.recallix.dto;

import com.recallix.entity.UserEntity;

/** Server-side user preferences (settings page). */
public record PreferencesResponse(
        boolean autoEmailRecap,
        /** The override address, or null when recaps go to the account email. */
        String recapEmail,
        /** Where recaps would actually be sent — shown so the choice is unambiguous. */
        String effectiveRecapEmail
) {
    public static PreferencesResponse from(UserEntity user) {
        return new PreferencesResponse(
                user.isAutoEmailRecap(),
                user.getRecapEmail(),
                user.effectiveRecapEmail());
    }
}
