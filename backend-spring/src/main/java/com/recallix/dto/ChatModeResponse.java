package com.recallix.dto;

import com.recallix.domain.ChatMode;

import java.util.Arrays;
import java.util.List;

/**
 * The composer's mode picker, described by the server.
 *
 * <p>Same reasoning as the notification kinds in V34: the wording of a control
 * that changes behaviour should come from the thing whose behaviour it changes,
 * so the line under each name cannot drift away from what that mode actually
 * does. It is also why renaming Express and Advanced to Quick and Thorough took
 * no frontend change: the picker draws whatever this sends.
 */
public record ChatModeResponse(String mode, String label, String hint, boolean isDefault) {

    public static List<ChatModeResponse> all() {
        return Arrays.stream(ChatMode.values())
                .map(m -> new ChatModeResponse(
                        m.wire(), m.label(), m.hint(), m == ChatMode.QUICK))
                .toList();
    }
}
