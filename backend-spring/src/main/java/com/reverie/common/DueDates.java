package com.reverie.common;

import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.Month;
import java.time.format.DateTimeParseException;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reads a spoken due date as a calendar date.
 *
 * <p>The extractor is told to record the timing "in the words used" — "Tuesday",
 * "end of day", "before the demo" — because that is what was actually promised
 * and rewriting it would be putting words in somebody's mouth. The cost is that
 * nothing downstream can do date arithmetic on it: overdue, due soon, sorting by
 * deadline and the reminder digest all need a date, and on real transcripts only
 * a small minority of items ever carry one.
 *
 * <p>So this resolves the phrasing against the date the meeting happened, which
 * is the reference everyone in the room was using. "Tuesday" said on Friday the
 * 12th means the 16th, and said again a week later means a different day — which
 * is exactly why the resolution happens per item at write time and is stored,
 * rather than being recomputed from today's date on every read.
 *
 * <p><strong>It refuses far more than it accepts, on purpose.</strong> A due date
 * we invented is worse than no due date: it produces a red "overdue" badge on a
 * task nobody is late with, and an email at seven in the morning about it. Every
 * pattern here is one where the phrase has a single reading. Anything else —
 * "before the demo", "next sprint", "asap", and notably any bare numeric form
 * like {@code 03/04} where a reader in Boston and a reader in London disagree
 * about the month — returns null, and null simply means the item shows the words
 * that were said and takes no part in the deadline features.
 */
public final class DueDates {

    private DueDates() {
    }

    /** Prepositions people put in front of a date; none of them change it. */
    private static final Pattern LEAD = Pattern.compile(
            "^(?:due|by|on|before|until|till|til|no later than|not later than|"
                    + "sometime|end of day|eod|cob|close of business|start of|beginning of)\\s+");

    /**
     * Times of day, and clock times. "Friday morning" and "Friday at 5" are
     * Friday: the hour is real information, but it is not a different day and
     * nothing here tracks hours.
     */
    private static final Pattern TRAIL = Pattern.compile(
            "\\s+(?:morning|afternoon|evening|night|eod|cob|"
                    + "at \\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?|\\d{1,2}\\s*(?:am|pm))$");

    private static final Pattern IN_N_UNITS = Pattern.compile(
            "^in (\\d{1,3}) (day|days|week|weeks|month|months)$");

    /** "20 august", "august 20", "aug 20 2026" — a month name is unambiguous. */
    private static final Pattern DAY_MONTH = Pattern.compile(
            "^(\\d{1,2})(?:st|nd|rd|th)? ([a-z]+)(?:,? (\\d{4}))?$");
    private static final Pattern MONTH_DAY = Pattern.compile(
            "^([a-z]+) (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?$");

    private static final Map<String, DayOfWeek> WEEKDAYS = Map.ofEntries(
            Map.entry("monday", DayOfWeek.MONDAY), Map.entry("mon", DayOfWeek.MONDAY),
            Map.entry("tuesday", DayOfWeek.TUESDAY), Map.entry("tue", DayOfWeek.TUESDAY),
            Map.entry("tues", DayOfWeek.TUESDAY),
            Map.entry("wednesday", DayOfWeek.WEDNESDAY), Map.entry("wed", DayOfWeek.WEDNESDAY),
            Map.entry("thursday", DayOfWeek.THURSDAY), Map.entry("thu", DayOfWeek.THURSDAY),
            Map.entry("thur", DayOfWeek.THURSDAY), Map.entry("thurs", DayOfWeek.THURSDAY),
            Map.entry("friday", DayOfWeek.FRIDAY), Map.entry("fri", DayOfWeek.FRIDAY),
            Map.entry("saturday", DayOfWeek.SATURDAY), Map.entry("sat", DayOfWeek.SATURDAY),
            Map.entry("sunday", DayOfWeek.SUNDAY), Map.entry("sun", DayOfWeek.SUNDAY));

    private static final Map<String, Month> MONTHS = Map.ofEntries(
            Map.entry("january", Month.JANUARY), Map.entry("jan", Month.JANUARY),
            Map.entry("february", Month.FEBRUARY), Map.entry("feb", Month.FEBRUARY),
            Map.entry("march", Month.MARCH), Map.entry("mar", Month.MARCH),
            Map.entry("april", Month.APRIL), Map.entry("apr", Month.APRIL),
            Map.entry("may", Month.MAY),
            Map.entry("june", Month.JUNE), Map.entry("jun", Month.JUNE),
            Map.entry("july", Month.JULY), Map.entry("jul", Month.JULY),
            Map.entry("august", Month.AUGUST), Map.entry("aug", Month.AUGUST),
            Map.entry("september", Month.SEPTEMBER), Map.entry("sep", Month.SEPTEMBER),
            Map.entry("sept", Month.SEPTEMBER),
            Map.entry("october", Month.OCTOBER), Map.entry("oct", Month.OCTOBER),
            Map.entry("november", Month.NOVEMBER), Map.entry("nov", Month.NOVEMBER),
            Map.entry("december", Month.DECEMBER), Map.entry("dec", Month.DECEMBER));

    /**
     * A month name with no year is read as the next occurrence, but a meeting on
     * the 3rd of August that says "due 1 August" means two days ago, not next
     * year. This is how far back a bare date is still read as the past.
     */
    private static final int BACKDATE_TOLERANCE_DAYS = 45;

    /**
     * @param spoken    the due date as recorded — free text, possibly null
     * @param reference the day the meeting happened; everything relative is
     *                  relative to this, never to today
     * @return the resolved date, or null when the phrasing has no single reading
     */
    public static LocalDate resolve(String spoken, LocalDate reference) {
        if (spoken == null || reference == null) {
            return null;
        }
        String s = normalise(spoken);
        if (s.isEmpty()) {
            return null;
        }

        // ISO first and before normalisation can matter to it: this is what the
        // date picker writes, so it is the common case as well as the exact one.
        LocalDate iso = tryIso(s);
        if (iso != null) {
            return iso;
        }

        // "by end of day friday" -> "friday". Applied repeatedly because people
        // stack them: "due by friday".
        String stripped = s;
        for (int i = 0; i < 3; i++) {
            Matcher lead = LEAD.matcher(stripped);
            if (!lead.find()) {
                break;
            }
            stripped = lead.replaceFirst("");
        }
        for (int i = 0; i < 2; i++) {
            String shorter = TRAIL.matcher(stripped).replaceFirst("");
            if (shorter.equals(stripped)) {
                break;
            }
            stripped = shorter;
        }
        if (stripped.isEmpty()) {
            return null;
        }

        LocalDate named = named(stripped, reference);
        if (named != null) {
            return named;
        }

        Matcher in = IN_N_UNITS.matcher(stripped);
        if (in.matches()) {
            int n = Integer.parseInt(in.group(1));
            return switch (in.group(2)) {
                case "day", "days" -> reference.plusDays(n);
                case "week", "weeks" -> reference.plusWeeks(n);
                default -> reference.plusMonths(n);
            };
        }

        DayOfWeek weekday = WEEKDAYS.get(dropQualifier(stripped));
        if (weekday != null) {
            return nextWeekday(reference, weekday);
        }

        return monthAndDay(stripped, reference);
    }

    /** Lower-cased, single-spaced, with trailing punctuation removed. */
    private static String normalise(String raw) {
        return raw.trim()
                .toLowerCase()
                .replaceAll("[.,;:!?]+$", "")
                .replaceAll("\\s+", " ")
                .trim();
    }

    private static LocalDate tryIso(String s) {
        if (!s.matches("\\d{4}-\\d{2}-\\d{2}")) {
            return null;
        }
        try {
            return LocalDate.parse(s);
        } catch (DateTimeParseException e) {
            // Well-shaped but not a real day — 2026-02-31. Nothing to resolve.
            return null;
        }
    }

    /**
     * "this friday", "next friday" and "friday" all mean the coming Friday when
     * said in a meeting. Treating "next" as the week after would be defensible
     * and is what a minority mean; guessing wrong there costs a week, and the
     * common reading is the near one.
     */
    private static String dropQualifier(String s) {
        return s.replaceFirst("^(?:this coming|coming|this|next) ", "");
    }

    private static LocalDate named(String s, LocalDate reference) {
        return switch (s) {
            case "today", "tonight", "this evening", "this afternoon", "end of day",
                 "eod", "cob", "close of business", "now", "immediately" -> reference;
            case "tomorrow" -> reference.plusDays(1);
            case "yesterday" -> reference.minusDays(1);
            case "next week" -> reference.plusWeeks(1);
            case "next month" -> reference.plusMonths(1);
            case "end of week", "eow", "end of the week", "this week" ->
                    nextOrSame(reference, DayOfWeek.FRIDAY);
            case "end of next week" -> nextWeekday(reference, DayOfWeek.FRIDAY).plusWeeks(1);
            case "end of month", "eom", "end of the month" ->
                    reference.withDayOfMonth(reference.lengthOfMonth());
            default -> null;
        };
    }

    /** The next such weekday strictly after the reference — "Friday" said on a Friday is a week away. */
    private static LocalDate nextWeekday(LocalDate from, DayOfWeek target) {
        LocalDate d = from.plusDays(1);
        while (d.getDayOfWeek() != target) {
            d = d.plusDays(1);
        }
        return d;
    }

    /** Like {@link #nextWeekday} but "end of week" on a Friday means that Friday. */
    private static LocalDate nextOrSame(LocalDate from, DayOfWeek target) {
        LocalDate d = from;
        while (d.getDayOfWeek() != target) {
            d = d.plusDays(1);
        }
        return d;
    }

    private static LocalDate monthAndDay(String s, LocalDate reference) {
        Matcher dayFirst = DAY_MONTH.matcher(s);
        if (dayFirst.matches()) {
            return build(MONTHS.get(dayFirst.group(2)), dayFirst.group(1), dayFirst.group(3), reference);
        }
        Matcher monthFirst = MONTH_DAY.matcher(s);
        if (monthFirst.matches()) {
            return build(MONTHS.get(monthFirst.group(1)), monthFirst.group(2), monthFirst.group(3), reference);
        }
        return null;
    }

    private static LocalDate build(Month month, String day, String year, LocalDate reference) {
        if (month == null) {
            return null;
        }
        int d = Integer.parseInt(day);
        if (d < 1 || d > month.length(true)) {
            return null;
        }
        if (year != null) {
            return safe(Integer.parseInt(year), month, d);
        }
        // No year given, so pick the reading that makes sense from the meeting:
        // the occurrence in the meeting's own year, rolled forward a year if
        // that would put the deadline well in the past.
        LocalDate sameYear = safe(reference.getYear(), month, d);
        if (sameYear == null) {
            return null;
        }
        return sameYear.isBefore(reference.minusDays(BACKDATE_TOLERANCE_DAYS))
                ? sameYear.plusYears(1)
                : sameYear;
    }

    /** Guards 29 February in a non-leap year, which {@link LocalDate#of} throws on. */
    private static LocalDate safe(int year, Month month, int day) {
        try {
            return LocalDate.of(year, month, day);
        } catch (RuntimeException e) {
            return null;
        }
    }
}
