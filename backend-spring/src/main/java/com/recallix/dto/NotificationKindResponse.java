package com.recallix.dto;

import com.recallix.domain.NotificationKind;

/**
 * One switch on the settings page.
 *
 * <p>Served rather than hard-coded in the client so that adding a kind is a
 * backend change only — and so the wording of what is being switched off cannot
 * drift from the wording of the notification itself.
 */
public record NotificationKindResponse(
        String kind,
        String label,
        /** How the setting reads: "Tell me {setting}". */
        String setting,
        /** False for the ones that cannot be switched off — currently only failures. */
        boolean mutable
) {
    public static NotificationKindResponse from(NotificationKind kind) {
        return new NotificationKindResponse(
                kind.name(), kind.label(), kind.setting(), kind.mutable());
    }
}
