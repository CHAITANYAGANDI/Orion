package com.recallix.dto;

import com.recallix.domain.NotificationKind;
import com.recallix.entity.Notification;

import java.time.Instant;

/**
 * One notification, as the bell renders it.
 *
 * <p>{@code title} and {@code body} are the words that were written when it
 * happened, not a template filled in now — a meeting renamed since still
 * finished under the name it had.
 *
 * <p>{@code kind} travels alongside them so the client can put an icon on it
 * and group a run of them, without having to parse the sentence.
 */
public record NotificationResponse(
        String id,
        NotificationKind kind,
        /** How the kind reads in a settings list, so the client keeps no copy of the enum. */
        String kindLabel,
        String title,
        String body,
        String meetingId,
        String actionItemId,
        /** Where clicking it goes, relative to the app root; may be null. */
        String link,
        boolean read,
        Instant readAt,
        Instant createdAt
) {
    public static NotificationResponse from(Notification n) {
        return new NotificationResponse(
                n.getId(),
                n.getKind(),
                n.getKind().label(),
                n.getTitle(),
                n.getBody(),
                n.getMeetingId(),
                n.getActionItemId(),
                n.getLink(),
                n.isRead(),
                n.getReadAt(),
                n.getCreatedAt());
    }
}
