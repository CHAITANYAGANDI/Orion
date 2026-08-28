package com.orion.dto;

import jakarta.validation.constraints.Size;

/**
 * Creating or editing a project.
 *
 * <p>Only the name is required, and on a rename even that is optional: an
 * omitted field is left alone, matching {@code MeetingUpdateRequest}. Being made
 * to describe "Client ABC" before you can file anything into it is the friction
 * that stops people filing anything.
 */
public record ProjectRequest(
        @Size(max = 120, message = "A project name can be at most 120 characters")
        String name,

        @Size(max = 500, message = "A project description can be at most 500 characters")
        String description,

        @Size(max = 40)
        String color,

        /**
         * Starred or not. Boxed, because an omitted field has to be
         * distinguishable from {@code false} — a rename that also silently
         * unstarred the project would be a rename nobody asked for.
         */
        Boolean favorite
) {
    public String nameOrNull() {
        return name == null || name.isBlank() ? null : name.trim();
    }
}
