package com.recallix.controller;

import com.recallix.security.SecurityUtils;
import com.recallix.service.CalendarFeedService;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;

/**
 * What Recallix connects to.
 *
 * <p>Exactly one thing, and it is real: a calendar feed of your action item
 * deadlines. The page that reads this also names what is <em>not</em> connected
 * and why, which is the more useful half — an integrations screen full of
 * greyed-out logos tells a reader nothing except that somebody drew them.
 *
 * <p>The feed itself is served from {@code /public/**} rather than from here,
 * because the caller is Google's or Apple's server and it has no session. See
 * {@code TenantFilter} for why that prefix is the one that works, and
 * {@link CalendarFeedService} for why the URL has to be the credential.
 */
@RestController
public class IntegrationsController {

    private final CalendarFeedService calendar;

    public IntegrationsController(CalendarFeedService calendar) {
        this.calendar = calendar;
    }

    @GetMapping("/api/v1/integrations/calendar")
    public CalendarFeedService.Feed calendarStatus() {
        return calendar.status(SecurityUtils.currentUserId());
    }

    /**
     * Create the feed, or rotate an existing one.
     *
     * <p>Rotation is the only revoke a published URL can have: the page says so
     * next to the button, because "regenerate" sounds harmless and it is the act
     * that breaks every calendar already subscribed.
     */
    @PostMapping("/api/v1/integrations/calendar")
    public CalendarFeedService.Feed enableCalendar() {
        return calendar.enable(SecurityUtils.currentUserId());
    }

    @DeleteMapping("/api/v1/integrations/calendar")
    public ResponseEntity<Void> disableCalendar() {
        calendar.disable(SecurityUtils.currentUserId());
        return ResponseEntity.noContent().build();
    }

    /**
     * The feed. Unauthenticated by necessity, and by design.
     *
     * <p>{@code .ics} on the end because several desktop readers decide how to
     * treat a subscription from the path rather than from the content type, and
     * one that guesses wrong downloads the file once instead of following it.
     */
    @GetMapping("/public/calendar/{token}.ics")
    public ResponseEntity<byte[]> feed(@PathVariable String token) {
        byte[] body = calendar.render(token).getBytes(StandardCharsets.UTF_8);
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType("text/calendar;charset=UTF-8"))
                .header(HttpHeaders.CONTENT_DISPOSITION, "inline; filename=\"recallix.ics\"")
                // Re-fetched every hour or so by somebody else's server; a cached
                // copy would mean a deadline set this morning appearing tomorrow.
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .body(body);
    }
}
