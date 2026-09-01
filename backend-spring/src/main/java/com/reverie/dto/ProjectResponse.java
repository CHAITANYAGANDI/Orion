package com.reverie.dto;

import com.reverie.entity.Project;

import java.time.Instant;

/**
 * A project, with the one number that makes it worth showing.
 *
 * <p>{@code meetingCount} is not decoration: a sidebar of names tells you what
 * you once meant to organise, and a sidebar of names with counts tells you where
 * the work actually is. It also answers, before anyone clicks, whether asking a
 * question of this project can produce anything at all.
 */
public record ProjectResponse(
        String id,
        String name,
        String description,
        String color,
        boolean favorite,
        long meetingCount,
        Instant createdAt,
        Instant updatedAt
) {
    public static ProjectResponse from(Project p, long meetingCount) {
        return new ProjectResponse(
                p.getId(),
                p.getName(),
                p.getDescription(),
                p.getColor(),
                p.isFavorite(),
                meetingCount,
                p.getCreatedAt(),
                p.getUpdatedAt());
    }
}
