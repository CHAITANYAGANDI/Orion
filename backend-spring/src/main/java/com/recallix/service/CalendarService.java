package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.common.IdGenerator;
import com.recallix.dto.CalendarEventResponse;
import com.recallix.dto.CalendarSubscribeRequest;
import com.recallix.dto.CalendarSubscriptionResponse;
import com.recallix.entity.CalendarSubscription;
import com.recallix.repository.CalendarSubscriptionRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * Read-only calendar sync over iCal (ICS).
 *
 * <p>Deliberately not OAuth. Every provider — Google, Outlook, Apple, Fastmail
 * — publishes a secret iCal URL from its own settings, so one mechanism covers
 * all of them with no app registration, no client secret, and no provider
 * verification review. The trade is polling instead of push, and no write
 * access, neither of which this feature needs: it exists to answer "what is
 * next, and where do I click to record it?".
 *
 * <p>Feeds are fetched on demand rather than on a schedule. An individual user
 * opens this page a handful of times a day, so a background poller would mean
 * far more requests to the provider than the feature justifies.
 */
@Service
public class CalendarService {

    private static final Logger log = LoggerFactory.getLogger(CalendarService.class);

    /** Refuse feeds larger than this — some shared calendars are enormous. */
    private static final int MAX_FEED_BYTES = 8 * 1024 * 1024;

    private final CalendarSubscriptionRepository subscriptions;
    private final UrlSafetyGuard urlSafety;
    private final AuditService audit;
    private final HttpClient http;
    private final int maxSubscriptions;

    public CalendarService(CalendarSubscriptionRepository subscriptions,
                           UrlSafetyGuard urlSafety,
                           AuditService audit,
                           @Value("${recallix.calendar.max-subscriptions:5}") int maxSubscriptions) {
        this.subscriptions = subscriptions;
        this.urlSafety = urlSafety;
        this.audit = audit;
        this.maxSubscriptions = maxSubscriptions;
        this.http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                // NEVER follow redirects: the guard validated the URL we were
                // given, and a redirect target would not have been checked.
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    // --- subscriptions -------------------------------------------------------- //

    @Transactional(readOnly = true)
    public List<CalendarSubscriptionResponse> list(String userId) {
        return subscriptions.findByUserIdOrderByCreatedAtAsc(userId).stream()
                .map(CalendarSubscriptionResponse::from)
                .toList();
    }

    @Transactional
    public CalendarSubscriptionResponse subscribe(String userId, CalendarSubscribeRequest req) {
        // Validated before anything is stored, so a hostile URL never lands in
        // the database where a later job might fetch it.
        URI uri = urlSafety.requireSafe(req.trimmedUrl());
        String url = uri.toString();

        subscriptions.findByUserIdAndUrl(userId, url).ifPresent(existing -> {
            throw ApiException.badRequest("That calendar is already connected");
        });
        if (subscriptions.findByUserIdOrderByCreatedAtAsc(userId).size() >= maxSubscriptions) {
            throw ApiException.badRequest("You can connect up to " + maxSubscriptions + " calendars");
        }

        // Fetch once before saving: a URL that does not return a calendar is a
        // typo, and failing now is far clearer than an empty list later.
        String body = fetch(uri);
        List<IcsParser.CalendarEvent> events = IcsParser.parse(body, Instant.now(), horizon());

        CalendarSubscription sub = new CalendarSubscription();
        sub.setId(IdGenerator.generate("cal_"));
        sub.setUserId(userId);
        sub.setUrl(url);
        sub.setLabel(labelFor(req.label(), uri));
        sub.setLastSyncedAt(Instant.now());
        sub.setEventCount(events.size());
        subscriptions.save(sub);

        audit.record(userId, "CALENDAR_CONNECTED", "calendar", sub.getId());
        return CalendarSubscriptionResponse.from(sub);
    }

    @Transactional
    public void unsubscribe(String userId, String id) {
        CalendarSubscription sub = subscriptions.findByIdAndUserId(id, userId)
                .orElseThrow(() -> ApiException.notFound("Calendar not found"));
        subscriptions.delete(sub);
        audit.record(userId, "CALENDAR_DISCONNECTED", "calendar", id);
    }

    // --- events --------------------------------------------------------------- //

    /**
     * Upcoming events across every connected calendar.
     *
     * <p>One unreachable feed must not empty the whole list, so a failure is
     * recorded against that subscription and the others still return.
     */
    @Transactional
    public List<CalendarEventResponse> upcoming(String userId, int days) {
        Instant from = Instant.now().minus(1, ChronoUnit.HOURS);  // include in-progress meetings
        Instant to = Instant.now().plus(Math.max(1, Math.min(days, 30)), ChronoUnit.DAYS);

        List<CalendarEventResponse> out = new ArrayList<>();
        for (CalendarSubscription sub : subscriptions.findByUserIdOrderByCreatedAtAsc(userId)) {
            try {
                String body = fetch(URI.create(sub.getUrl()));
                List<IcsParser.CalendarEvent> events = IcsParser.parse(body, from, to);
                for (IcsParser.CalendarEvent e : events) {
                    out.add(CalendarEventResponse.from(e, sub.getLabel()));
                }
                sub.setLastSyncedAt(Instant.now());
                sub.setLastError(null);
                sub.setEventCount(events.size());
            } catch (Exception e) {
                // Surfaced on the subscription so the UI can explain a stale
                // calendar instead of silently showing nothing.
                log.warn("Calendar {} failed to sync: {}", sub.getId(), e.toString());
                sub.setLastError(shortMessage(e));
            }
        }
        out.sort(Comparator.comparing(CalendarEventResponse::start));
        return out;
    }

    // --- fetching ------------------------------------------------------------- //

    private String fetch(URI uri) {
        HttpRequest request = HttpRequest.newBuilder(uri)
                .timeout(Duration.ofSeconds(20))
                .header("Accept", "text/calendar, text/plain")
                .header("User-Agent", "Recallix/1.0")
                .GET()
                .build();
        try {
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            int status = response.statusCode();
            if (status >= 300 && status < 400) {
                // Deliberate: following would reach a URL the guard never saw.
                throw ApiException.badRequest(
                        "That calendar URL redirects, which isn't supported. Use the direct iCal address.");
            }
            if (status != 200) {
                throw ApiException.badRequest("The calendar returned HTTP " + status);
            }
            String body = response.body();
            if (body == null || body.length() > MAX_FEED_BYTES) {
                throw ApiException.badRequest("That calendar feed is too large");
            }
            if (!body.contains("BEGIN:VCALENDAR")) {
                throw ApiException.badRequest(
                        "That URL didn't return a calendar. Copy the iCal / ICS address from your "
                                + "calendar's settings — it usually ends in .ics.");
            }
            return body;
        } catch (ApiException e) {
            throw e;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw ApiException.badRequest("Fetching the calendar was interrupted");
        } catch (Exception e) {
            throw ApiException.badRequest("Could not reach that calendar: " + e.getMessage());
        }
    }

    private static Instant horizon() {
        return Instant.now().plus(14, ChronoUnit.DAYS);
    }

    private static String labelFor(String supplied, URI uri) {
        if (supplied != null && !supplied.isBlank()) {
            return supplied.trim();
        }
        String host = uri.getHost();
        if (host == null) {
            return "Calendar";
        }
        // "calendar.google.com" -> "Google", "outlook.office365.com" -> "Outlook"
        if (host.contains("google")) return "Google Calendar";
        if (host.contains("outlook") || host.contains("office365") || host.contains("live.com")) {
            return "Outlook";
        }
        if (host.contains("icloud")) return "Apple Calendar";
        return host;
    }

    private static String shortMessage(Exception e) {
        String message = e.getMessage();
        if (message == null || message.isBlank()) {
            return e.getClass().getSimpleName();
        }
        return message.length() > 200 ? message.substring(0, 200) + "…" : message;
    }
}
