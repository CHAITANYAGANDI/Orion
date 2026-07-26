package com.recallix.dto;

import com.recallix.entity.CalendarSubscription;

import java.time.Instant;

/**
 * A subscribed calendar, safe to send to the browser.
 *
 * <p>The iCal URL is a bearer secret — it grants read access to the entire
 * calendar to anyone who holds it — so only a redacted form leaves the server.
 * The user has the real URL already; echoing it back adds nothing and puts it
 * in browser history, logs and screenshots.
 */
public record CalendarSubscriptionResponse(
        String id,
        String label,
        /** Host plus an elided path, enough to tell two calendars apart. */
        String redactedUrl,
        Instant lastSyncedAt,
        String lastError,
        int eventCount
) {
    public static CalendarSubscriptionResponse from(CalendarSubscription s) {
        return new CalendarSubscriptionResponse(
                s.getId(),
                s.getLabel(),
                redact(s.getUrl()),
                s.getLastSyncedAt(),
                s.getLastError(),
                s.getEventCount());
    }

    static String redact(String url) {
        if (url == null || url.isBlank()) {
            return "";
        }
        try {
            java.net.URI uri = new java.net.URI(url);
            String host = uri.getHost() == null ? "calendar" : uri.getHost();
            return host + "/…";
        } catch (Exception e) {
            return "…";
        }
    }
}
