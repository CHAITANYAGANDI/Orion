package com.recallix.event;

/**
 * Published when somebody outside the workspace opens a shared link.
 *
 * <p>An event rather than a direct call, because the notification and the page
 * view have opposite requirements. Resolving a share runs unauthenticated and
 * with no tenant; writing a notification needs one. And the notification is
 * deduplicated per link per day by a unique index, so a link opened by forty
 * people at once produces thirty-nine losing inserts — which, inside the
 * request's transaction, would be thirty-nine broken share pages.
 *
 * <p>Consumed after commit, on another thread, where a failure costs a
 * notification and nothing else.
 */
public record ShareViewedEvent(String shareId, String meetingId, String ownerUserId) {
}
