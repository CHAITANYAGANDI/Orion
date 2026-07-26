package com.recallix.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Minimal iCalendar (RFC 5545) reader — enough to answer "what meetings do I
 * have coming up, and what's the join link?".
 *
 * <p>Pure and static so the whole thing is testable without a network or a
 * database, which matters: calendar feeds are the kind of input that is
 * malformed in a hundred small ways.
 *
 * <p><b>Recurrence is deliberately partial.</b> DAILY and WEEKLY rules with
 * INTERVAL, COUNT, UNTIL and BYDAY are expanded, because that is what daily
 * standups and weekly one-to-ones actually use. MONTHLY and YEARLY rules yield
 * only their first occurrence, and EXDATE is honoured but RDATE is not. Full
 * RRULE expansion is a genuinely hard problem and getting it subtly wrong is
 * worse than not claiming it — a rule this parser does not understand degrades
 * to one event rather than to a wrong series.
 */
public final class IcsParser {

    private static final Logger log = LoggerFactory.getLogger(IcsParser.class);

    /** Refuse to expand a rule into more than this many occurrences. */
    private static final int MAX_OCCURRENCES = 500;

    private static final DateTimeFormatter DATE_TIME =
            DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss", Locale.ROOT);
    private static final DateTimeFormatter DATE =
            DateTimeFormatter.ofPattern("yyyyMMdd", Locale.ROOT);

    /**
     * Join links worth surfacing. Ordered: LOCATION usually holds a clean link,
     * DESCRIPTION often holds several (dial-in, help page) and the first match
     * is the one people click.
     */
    private static final Pattern MEETING_URL = Pattern.compile(
            "https?://(?:[\\w-]+\\.)*(?:"
                    + "zoom\\.us/j/\\S+"
                    + "|meet\\.google\\.com/[\\w-]+"
                    + "|teams\\.microsoft\\.com/l/meetup-join/\\S+"
                    + "|teams\\.live\\.com/meet/\\S+"
                    + "|webex\\.com/\\S+"
                    + "|whereby\\.com/\\S+"
                    + "|meet\\.jit\\.si/\\S+"
                    + ")",
            Pattern.CASE_INSENSITIVE);

    private IcsParser() {
    }

    /** One occurrence of a calendar event. */
    public record CalendarEvent(
            String uid,
            String title,
            Instant start,
            Instant end,
            String location,
            /** Extracted join link, or null when the event has no online meeting. */
            String meetingUrl,
            boolean allDay
    ) {
    }

    /**
     * Parse a feed and return occurrences that overlap [from, to), earliest
     * first. Events that cannot be understood are skipped rather than fatal:
     * one broken VEVENT must not cost the user their whole calendar.
     */
    public static List<CalendarEvent> parse(String ics, Instant from, Instant to) {
        if (ics == null || ics.isBlank()) {
            return List.of();
        }

        List<CalendarEvent> out = new ArrayList<>();
        for (List<String> block : eventBlocks(unfold(ics))) {
            try {
                out.addAll(parseEvent(block, from, to));
            } catch (Exception e) {
                log.debug("Skipping unparseable VEVENT: {}", e.toString());
            }
        }
        out.sort((a, b) -> a.start().compareTo(b.start()));
        return out;
    }

    // --- lexing --------------------------------------------------------------- //

    /**
     * Undo RFC 5545 line folding: a line beginning with a space or tab is a
     * continuation of the previous one. Long URLs are routinely folded, so
     * skipping this step corrupts exactly the join links we care about.
     */
    static List<String> unfold(String ics) {
        List<String> lines = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        for (String raw : ics.split("\\r?\\n")) {
            if (!raw.isEmpty() && (raw.charAt(0) == ' ' || raw.charAt(0) == '\t')) {
                current.append(raw, 1, raw.length());
            } else {
                if (current.length() > 0) {
                    lines.add(current.toString());
                }
                current.setLength(0);
                current.append(raw);
            }
        }
        if (current.length() > 0) {
            lines.add(current.toString());
        }
        return lines;
    }

    private static List<List<String>> eventBlocks(List<String> lines) {
        List<List<String>> blocks = new ArrayList<>();
        List<String> current = null;
        for (String line : lines) {
            if (line.startsWith("BEGIN:VEVENT")) {
                current = new ArrayList<>();
            } else if (line.startsWith("END:VEVENT")) {
                if (current != null) {
                    blocks.add(current);
                }
                current = null;
            } else if (current != null) {
                current.add(line);
            }
        }
        return blocks;
    }

    /** A property line split into name, parameters and value. */
    private record Property(String name, Map<String, String> params, String value) {
    }

    private static Property property(String line) {
        int colon = indexOfUnquoted(line, ':');
        if (colon < 0) {
            return null;
        }
        String head = line.substring(0, colon);
        String value = line.substring(colon + 1);

        String[] parts = head.split(";");
        Map<String, String> params = new HashMap<>();
        for (int i = 1; i < parts.length; i++) {
            int eq = parts[i].indexOf('=');
            if (eq > 0) {
                params.put(parts[i].substring(0, eq).toUpperCase(Locale.ROOT),
                        stripQuotes(parts[i].substring(eq + 1)));
            }
        }
        return new Property(parts[0].toUpperCase(Locale.ROOT), params, value);
    }

    /**
     * A colon inside a quoted parameter value is not the value separator —
     * {@code DTSTART;TZID="America/New_York":2026...} is legal.
     */
    private static int indexOfUnquoted(String s, char target) {
        boolean quoted = false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"') {
                quoted = !quoted;
            } else if (c == target && !quoted) {
                return i;
            }
        }
        return -1;
    }

    private static String stripQuotes(String s) {
        if (s.length() >= 2 && s.charAt(0) == '"' && s.charAt(s.length() - 1) == '"') {
            return s.substring(1, s.length() - 1);
        }
        return s;
    }

    /** RFC 5545 TEXT escaping. */
    static String unescape(String value) {
        if (value == null || value.indexOf('\\') < 0) {
            return value;
        }
        StringBuilder sb = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '\\' && i + 1 < value.length()) {
                char next = value.charAt(++i);
                switch (next) {
                    case 'n', 'N' -> sb.append('\n');
                    case ',' -> sb.append(',');
                    case ';' -> sb.append(';');
                    case '\\' -> sb.append('\\');
                    default -> sb.append(next);
                }
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    // --- events --------------------------------------------------------------- //

    private static List<CalendarEvent> parseEvent(List<String> block, Instant from, Instant to) {
        String uid = null;
        String summary = null;
        String location = null;
        String description = null;
        String rrule = null;
        Instant start = null;
        Instant end = null;
        boolean allDay = false;
        Set<Instant> exceptions = new LinkedHashSet<>();
        ZoneId startZone = ZoneOffset.UTC;

        for (String line : block) {
            Property p = property(line);
            if (p == null) {
                continue;
            }
            switch (p.name()) {
                case "UID" -> uid = p.value();
                case "SUMMARY" -> summary = unescape(p.value());
                case "LOCATION" -> location = unescape(p.value());
                case "DESCRIPTION" -> description = unescape(p.value());
                case "RRULE" -> rrule = p.value();
                case "DTSTART" -> {
                    allDay = "DATE".equalsIgnoreCase(p.params().get("VALUE"));
                    startZone = zoneOf(p);
                    start = toInstant(p.value(), startZone);
                }
                case "DTEND" -> end = toInstant(p.value(), zoneOf(p));
                case "EXDATE" -> {
                    ZoneId zone = zoneOf(p);
                    for (String one : p.value().split(",")) {
                        Instant parsed = toInstant(one.trim(), zone);
                        if (parsed != null) {
                            exceptions.add(parsed);
                        }
                    }
                }
                default -> { /* everything else is irrelevant here */ }
            }
        }

        if (start == null) {
            return List.of();
        }
        if (end == null) {
            // No DTEND is legal. An all-day event runs a day; anything else
            // gets an hour, which is the common default and only affects display.
            end = start.plusSeconds(allDay ? 86_400 : 3_600);
        }

        String meetingUrl = findMeetingUrl(location, description);
        long durationSeconds = Math.max(0, end.getEpochSecond() - start.getEpochSecond());

        List<CalendarEvent> out = new ArrayList<>();
        for (Instant occurrence : occurrences(start, rrule, startZone, from, to)) {
            if (exceptions.contains(occurrence)) {
                continue;
            }
            Instant occurrenceEnd = occurrence.plusSeconds(durationSeconds);
            // Overlap, not containment: a meeting already in progress is still
            // one the user might want to record.
            if (occurrenceEnd.isAfter(from) && occurrence.isBefore(to)) {
                out.add(new CalendarEvent(
                        uid, summary == null || summary.isBlank() ? "(no title)" : summary,
                        occurrence, occurrenceEnd, location, meetingUrl, allDay));
            }
        }
        return out;
    }

    private static ZoneId zoneOf(Property p) {
        String tzid = p.params().get("TZID");
        if (tzid == null || tzid.isBlank()) {
            return ZoneOffset.UTC;
        }
        try {
            return ZoneId.of(tzid);
        } catch (Exception e) {
            // Outlook emits Windows zone names ("GMT Standard Time") that the
            // JDK cannot resolve. UTC keeps the event rather than dropping it.
            log.debug("Unknown TZID '{}'; falling back to UTC.", tzid);
            return ZoneOffset.UTC;
        }
    }

    static Instant toInstant(String value, ZoneId zone) {
        if (value == null || value.isBlank()) {
            return null;
        }
        String v = value.trim();
        try {
            if (v.endsWith("Z")) {
                return LocalDateTime.parse(v.substring(0, v.length() - 1), DATE_TIME)
                        .toInstant(ZoneOffset.UTC);
            }
            if (v.length() == 8) {
                return LocalDate.parse(v, DATE).atStartOfDay(zone).toInstant();
            }
            return LocalDateTime.parse(v, DATE_TIME).atZone(zone).toInstant();
        } catch (Exception e) {
            return null;
        }
    }

    // --- recurrence ------------------------------------------------------------ //

    /**
     * Expand a recurrence rule across the window. Anything not understood
     * returns the single original occurrence — a rule we cannot expand should
     * cost the user one event, not a wrong series.
     */
    static List<Instant> occurrences(Instant start, String rrule, ZoneId zone,
                                     Instant from, Instant to) {
        if (rrule == null || rrule.isBlank()) {
            return List.of(start);
        }

        Map<String, String> parts = new HashMap<>();
        for (String piece : rrule.split(";")) {
            int eq = piece.indexOf('=');
            if (eq > 0) {
                parts.put(piece.substring(0, eq).toUpperCase(Locale.ROOT),
                        piece.substring(eq + 1).toUpperCase(Locale.ROOT));
            }
        }

        String freq = parts.get("FREQ");
        if (!"DAILY".equals(freq) && !"WEEKLY".equals(freq)) {
            return List.of(start);
        }

        int interval = parseIntOr(parts.get("INTERVAL"), 1);
        if (interval < 1) {
            interval = 1;
        }
        int count = parseIntOr(parts.get("COUNT"), Integer.MAX_VALUE);
        Instant until = parts.containsKey("UNTIL") ? toInstant(parts.get("UNTIL"), zone) : null;
        Set<DayOfWeek> byDay = parseByDay(parts.get("BYDAY"));

        Instant hardStop = until != null && until.isBefore(to) ? until : to;

        List<Instant> out = new ArrayList<>();
        LocalDateTime cursor = LocalDateTime.ofInstant(start, zone);
        int emitted = 0;

        for (int guard = 0; guard < MAX_OCCURRENCES && emitted < count; guard++) {
            Instant instant = cursor.atZone(zone).toInstant();
            if (instant.isAfter(hardStop)) {
                break;
            }

            boolean dayMatches = byDay.isEmpty() || byDay.contains(cursor.getDayOfWeek());
            if (dayMatches) {
                emitted++;
                if (!instant.isBefore(from.minusSeconds(86_400))) {
                    out.add(instant);
                }
            }

            // WEEKLY with BYDAY walks day by day so each listed weekday is
            // visited; the interval then applies per week, not per step.
            if ("WEEKLY".equals(freq) && !byDay.isEmpty()) {
                LocalDateTime next = cursor.plusDays(1);
                if (next.getDayOfWeek() == DayOfWeek.MONDAY && interval > 1) {
                    next = next.plusWeeks(interval - 1L);
                }
                cursor = next;
            } else if ("WEEKLY".equals(freq)) {
                cursor = cursor.plusWeeks(interval);
            } else {
                cursor = cursor.plusDays(interval);
            }
        }
        return out;
    }

    private static Set<DayOfWeek> parseByDay(String byDay) {
        Set<DayOfWeek> days = new LinkedHashSet<>();
        if (byDay == null || byDay.isBlank()) {
            return days;
        }
        for (String token : byDay.split(",")) {
            // Strip any ordinal prefix ("2TU" = second Tuesday); the ordinal
            // only means something for MONTHLY, which is not expanded here.
            String code = token.trim().replaceAll("^[+-]?\\d+", "");
            switch (code) {
                case "MO" -> days.add(DayOfWeek.MONDAY);
                case "TU" -> days.add(DayOfWeek.TUESDAY);
                case "WE" -> days.add(DayOfWeek.WEDNESDAY);
                case "TH" -> days.add(DayOfWeek.THURSDAY);
                case "FR" -> days.add(DayOfWeek.FRIDAY);
                case "SA" -> days.add(DayOfWeek.SATURDAY);
                case "SU" -> days.add(DayOfWeek.SUNDAY);
                default -> { /* ignore junk */ }
            }
        }
        return days;
    }

    private static int parseIntOr(String value, int fallback) {
        if (value == null) {
            return fallback;
        }
        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    // --- join links ------------------------------------------------------------ //

    static String findMeetingUrl(String location, String description) {
        for (String field : new String[]{location, description}) {
            if (field == null || field.isBlank()) {
                continue;
            }
            Matcher m = MEETING_URL.matcher(field);
            if (m.find()) {
                // Calendar text often runs a URL into following punctuation.
                return m.group().replaceAll("[>,;\\)\\]]+$", "");
            }
        }
        return null;
    }
}
