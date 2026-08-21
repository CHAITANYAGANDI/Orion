package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.entity.MeetingActionItem;
import com.recallix.entity.UserEntity;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.UserRepository;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.security.SecureRandom;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Your deadlines, in your own calendar.
 *
 * <p>The one integration Recallix can honestly ship today, and it is the
 * outbound direction rather than the inbound one. V8 added a table for reading
 * somebody's calendar and nothing ever used it, because the only useful thing to
 * do with a list of upcoming meetings is join them to record — and Recallix has
 * no bot. It records from your own browser tab. So the inbound direction ends in
 * a list you cannot act on.
 *
 * <p>Outbound works today and asks nothing of anybody. Action items already
 * carry resolved dates; every calendar application on earth subscribes to an ICS
 * URL; and there is no OAuth client to register, no provider review to pass and
 * no third-party credential to store. What it buys is the thing the daily digest
 * email cannot: a deadline that appears where somebody already looks.
 *
 * <p><strong>The URL is the credential.</strong> Google's servers fetch it with
 * no session and no header we could add, so the token has to be unguessable and
 * revocable. It is 192 bits from {@link SecureRandom}, it is never derived from
 * the user id, and rotating it invalidates every copy of the old URL at once —
 * which is the only revoke a published URL can have.
 */
@Service
public class CalendarFeedService {

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int TOKEN_BYTES = 24;

    /**
     * How far back finished and stale deadlines are still published.
     *
     * <p>A calendar is a record of a period, not an inbox: an item that was due
     * last Tuesday should still be visible last Tuesday. Older than this and it
     * is history nobody scrolls to, and every extra event is weight in a file
     * that is re-fetched every few hours.
     */
    private static final int LOOK_BACK_DAYS = 90;

    /** ICS wants UTC basic-format timestamps, and dates without separators. */
    private static final DateTimeFormatter STAMP =
            DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC);
    private static final DateTimeFormatter DAY = DateTimeFormatter.ofPattern("yyyyMMdd");

    /** RFC 5545 says fold at 75 octets. Most readers cope without; some do not. */
    private static final int FOLD_AT = 73;

    private final UserRepository users;
    private final MeetingActionItemRepository actionItems;
    private final MeetingRepository meetings;
    private final String apiUrl;
    private final String frontendUrl;

    public CalendarFeedService(UserRepository users,
                               MeetingActionItemRepository actionItems,
                               MeetingRepository meetings,
                               @Value("${app.public-url:http://localhost:8080}") String apiUrl,
                               @Value("${app.frontend-url:http://localhost:3000}") String frontendUrl) {
        this.users = users;
        this.actionItems = actionItems;
        this.meetings = meetings;
        this.apiUrl = stripSlash(apiUrl);
        this.frontendUrl = stripSlash(frontendUrl);
    }

    /* ------------------------------ the switch ------------------------------ */

    /**
     * Turn the feed on, or rotate the URL of one already on.
     *
     * <p>One method for both because they are the same act with different
     * intent, and separating them would mean a "rotate" that failed differently
     * on an account that had never subscribed.
     */
    @Transactional
    public Feed enable(String userId) {
        UserEntity user = require(userId);
        user.setCalendarToken(newToken());
        user.setCalendarTokenCreatedAt(Instant.now());
        return feedFor(user);
    }

    /** Withdraw the URL. Every calendar holding it starts returning 404. */
    @Transactional
    public void disable(String userId) {
        UserEntity user = require(userId);
        user.setCalendarToken(null);
        user.setCalendarTokenCreatedAt(null);
    }

    @Transactional(readOnly = true)
    public Feed status(String userId) {
        return feedFor(require(userId));
    }

    private Feed feedFor(UserEntity user) {
        String token = user.getCalendarToken();
        long deadlines = token == null ? 0 : actionItems.findDueThrough(
                user.getId(), LocalDate.now(ZoneOffset.UTC).plusYears(5)).size();
        return new Feed(
                token != null,
                token == null ? null : apiUrl + "/public/calendar/" + token + ".ics",
                // webcal:// is what makes a click subscribe rather than download.
                // Every desktop calendar registers the scheme; the https form is
                // beside it because Google's web UI wants that one pasted in.
                token == null ? null : "webcal://" + stripScheme(apiUrl) + "/public/calendar/" + token + ".ics",
                user.getCalendarTokenCreatedAt(),
                (int) deadlines);
    }

    /**
     * What the integrations page shows.
     *
     * @param url        the https form, for pasting into Google Calendar
     * @param webcalUrl  the clickable form, which desktop calendars subscribe to
     * @param deadlines  how many dated, unfinished items the feed currently has
     */
    public record Feed(boolean enabled, String url, String webcalUrl,
                       Instant createdAt, int deadlines) {
    }

    /* -------------------------------- the feed ------------------------------ */

    /**
     * Render one account's deadlines as an iCalendar document.
     *
     * <p>Runs unauthenticated in system context, so the token lookup is the
     * whole access check and nothing below may take a user id from anywhere but
     * the row that token found.
     *
     * <p>Every item becomes an all-day VEVENT on the day it is due. Not a timed
     * one: the deadline Recallix knows is a date — "Friday" — and inventing 09:00
     * for it would put a false precision in somebody's calendar, in whatever
     * time zone the server happened to think in.
     */
    @Transactional(readOnly = true)
    public String render(String token) {
        UserEntity user = users.findByCalendarToken(token)
                .orElseThrow(() -> ApiException.notFound("No such calendar"));

        LocalDate today = LocalDate.now(ZoneOffset.UTC);
        List<MeetingActionItem> items = actionItems
                .findDueThrough(user.getId(), today.plusYears(5)).stream()
                .filter(a -> a.getDueOn() != null && !a.getDueOn().isBefore(today.minusDays(LOOK_BACK_DAYS)))
                .toList();

        Map<String, String> titles = meetings.findAllById(items.stream()
                        .map(MeetingActionItem::getMeetingId)
                        .filter(java.util.Objects::nonNull)
                        .collect(Collectors.toSet())).stream()
                .collect(Collectors.toMap(m -> m.getId(), m -> m.getTitle(), (a, b) -> a));

        StringBuilder ics = new StringBuilder();
        line(ics, "BEGIN:VCALENDAR");
        line(ics, "VERSION:2.0");
        line(ics, "PRODID:-//Recallix//Deadlines//EN");
        line(ics, "CALSCALE:GREGORIAN");
        line(ics, "METHOD:PUBLISH");
        line(ics, "X-WR-CALNAME:Recallix action items");
        line(ics, "X-WR-CALDESC:Deadlines from your meetings, published by Recallix.");
        // Advisory, and worth setting: without it Google re-fetches on its own
        // schedule, which for a rarely-changing feed has been known to be daily.
        line(ics, "REFRESH-INTERVAL;VALUE=DURATION:PT1H");
        line(ics, "X-PUBLISHED-TTL:PT1H");

        String stamp = STAMP.format(Instant.now());
        for (MeetingActionItem item : items) {
            line(ics, "BEGIN:VEVENT");
            // Stable across regenerations of the file: a UID that changed would
            // make every refresh delete and recreate the event, losing whatever
            // the person had done to it in their own calendar.
            line(ics, "UID:" + item.getId() + "@recallix");
            line(ics, "DTSTAMP:" + stamp);
            line(ics, "DTSTART;VALUE=DATE:" + DAY.format(item.getDueOn()));
            // Exclusive end, per RFC 5545: a one-day event ends the next day.
            line(ics, "DTEND;VALUE=DATE:" + DAY.format(item.getDueOn().plusDays(1)));
            line(ics, "SUMMARY:" + escape(summaryOf(item)));
            line(ics, "DESCRIPTION:" + escape(descriptionOf(item, titles)));
            line(ics, "URL:" + frontendUrl + linkOf(item));
            line(ics, "CATEGORIES:Recallix");
            line(ics, "TRANSP:TRANSPARENT");
            // A deadline is not an appointment: it does not make you busy, and a
            // calendar that blocked the whole day for "send the deck" would be
            // uninstalled by lunchtime.
            line(ics, "BEGIN:VALARM");
            line(ics, "TRIGGER:-P1D");
            line(ics, "ACTION:DISPLAY");
            line(ics, "DESCRIPTION:" + escape("Due tomorrow: " + item.getTitle()));
            line(ics, "END:VALARM");
            line(ics, "END:VEVENT");
        }
        line(ics, "END:VCALENDAR");
        return ics.toString();
    }

    /* -------------------------------- wording ------------------------------- */

    /** "Priya: send the deck" — owner first, because a shared calendar has several. */
    private static String summaryOf(MeetingActionItem item) {
        String owner = item.getOwnerName();
        return owner == null || owner.isBlank()
                ? item.getTitle()
                : owner.trim() + ": " + item.getTitle();
    }

    private static String descriptionOf(MeetingActionItem item, Map<String, String> titles) {
        StringBuilder body = new StringBuilder();
        String meeting = item.getMeetingId() == null ? null : titles.get(item.getMeetingId());
        if (meeting != null) {
            body.append("From: ").append(meeting).append("\n");
        } else {
            body.append("Added by hand in Recallix.\n");
        }
        if (item.getDueDate() != null && !item.getDueDate().isBlank()) {
            body.append("Said as: ").append(item.getDueDate().trim()).append("\n");
        }
        if (item.getSourceSentence() != null && !item.getSourceSentence().isBlank()) {
            body.append("\n“").append(item.getSourceSentence().trim()).append("”\n");
        }
        return body.toString();
    }

    private static String linkOf(MeetingActionItem item) {
        // A commitment out of a transcript opens on its meeting, where the
        // sentence it came from is a click away. One somebody typed has no
        // meeting to open, so it opens the panel it was typed into.
        return item.getMeetingId() == null
                ? "/home"
                : "/meetings/" + item.getMeetingId() + "?tab=actions";
    }

    /* -------------------------------- plumbing ------------------------------ */

    /**
     * Escape per RFC 5545: backslash, semicolon and comma are separators, and a
     * newline has to travel as the two characters {@code \n}.
     *
     * <p>The backslash goes first. Doing it last would escape the backslashes
     * introduced by the rules before it, and a description containing a comma
     * would arrive with a stray character in every calendar that read it.
     */
    static String escape(String text) {
        if (text == null) {
            return "";
        }
        return text.replace("\\", "\\\\")
                .replace(";", "\\;")
                .replace(",", "\\,")
                .replace("\r\n", "\\n")
                .replace("\n", "\\n")
                .replace("\r", "\\n");
    }

    /**
     * Append a content line, folded and CRLF-terminated.
     *
     * <p>Folding is by octet, not by character: a line split in the middle of a
     * multi-byte character produces two invalid bytes, which is how a calendar
     * full of names in Hindi or Japanese ends up rejected wholesale by a reader
     * that was happy with the ASCII one.
     */
    static void line(StringBuilder out, String content) {
        byte[] bytes = content.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        if (bytes.length <= FOLD_AT) {
            out.append(content).append("\r\n");
            return;
        }
        int from = 0;
        boolean first = true;
        while (from < bytes.length) {
            int take = Math.min(FOLD_AT, bytes.length - from);
            // Back off the split until it lands on a character boundary. A
            // continuation byte is 10xxxxxx.
            while (take > 1 && from + take < bytes.length
                    && (bytes[from + take] & 0xC0) == 0x80) {
                take--;
            }
            if (!first) {
                out.append(' ');
            }
            out.append(new String(bytes, from, take, java.nio.charset.StandardCharsets.UTF_8));
            out.append("\r\n");
            from += take;
            first = false;
        }
    }

    private static String newToken() {
        byte[] bytes = new byte[TOKEN_BYTES];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private UserEntity require(String userId) {
        return users.findById(userId)
                .orElseThrow(() -> ApiException.unauthorized("Unknown user"));
    }

    private static String stripSlash(String url) {
        return url != null && url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
    }

    private static String stripScheme(String url) {
        return url.replaceFirst("^https?://", "");
    }
}
