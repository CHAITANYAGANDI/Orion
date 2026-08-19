package com.recallix.event;

/**
 * Something happened in a workspace that one of the V43 email switches covers.
 *
 * <p>One event with a {@link Kind} rather than three records, because all three
 * are consumed identically: after commit, on another thread, to decide whether a
 * message is owed and to send at most one a day. Three near-identical records
 * and three near-identical listeners would be three places to fix the next time
 * that decision changes.
 *
 * <p>An event rather than a direct call for the reason every mail in Recallix is
 * one: {@code EmailService.send} blocks on an SMTP round trip, and adding that
 * to the request that saved a highlight would make marking up a transcript feel
 * like the network hiccuped. After commit, so the row a message describes is
 * actually visible to the thread describing it.
 *
 * @param userId  whose workspace, and therefore whose switches and address
 * @param kind    which switch governs it
 * @param subject what it happened to — a meeting id, or an action item id
 * @param detail  the quoted text, comment body or meeting title; may be blank
 */
public record WorkspaceActivityEvent(String userId, Kind kind, String subject, String detail) {

    public enum Kind {
        /** A comment landed on an action item. Governed by {@code users.comment_email}. */
        COMMENT_ADDED,
        /** A highlight was added to a transcript. Governed by {@code users.highlight_email}. */
        HIGHLIGHT_ADDED
    }
}
