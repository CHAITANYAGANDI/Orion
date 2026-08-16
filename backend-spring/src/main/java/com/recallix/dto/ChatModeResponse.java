package com.recallix.dto;

import com.recallix.domain.ChatMode;

import java.util.Arrays;
import java.util.List;

/**
 * The composer's mode picker, described by the server.
 *
 * <p>Same reasoning as the notification kinds in V34: the wording of a control
 * that changes behaviour should come from the thing whose behaviour it changes,
 * so "Balanced for accuracy and speed" cannot drift away from what express
 * actually does.
 */
public record ChatModeResponse(String mode, String label, String hint, boolean isDefault) {

    public static List<ChatModeResponse> all() {
        return Arrays.stream(ChatMode.values())
                .map(m -> new ChatModeResponse(
                        m.wire(), m.label(), m.hint(), m == ChatMode.EXPRESS))
                .toList();
    }
}
