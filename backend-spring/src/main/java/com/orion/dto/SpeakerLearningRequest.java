package com.orion.dto;

import jakarta.validation.constraints.NotNull;

/**
 * Turn speaker learning on, or off.
 *
 * <p>{@code enabled} is {@code @NotNull} rather than defaulting, because the
 * two values do very different things and an omitted field must not pick one.
 * Off deletes every voice template the account holds.
 */
public record SpeakerLearningRequest(@NotNull Boolean enabled) {
}
