package com.reverie.dto;

/**
 * The badge, and where to listen for changes to it.
 *
 * <p>{@code channel} is the STOMP topic suffix — {@code /topic/users/{channel}/notifications}
 * — and it is returned rather than derived because the browser is authenticated
 * as a Clerk subject and has never been told the internal user id. Nothing
 * secret travels on that topic; see {@code NotificationPublisher} for why the
 * frames carry a count and nothing else.
 */
public record NotificationCountResponse(long unread, String channel) {
}
