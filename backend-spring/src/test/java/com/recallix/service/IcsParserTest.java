package com.recallix.service;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The iCalendar reader.
 *
 * <p>Calendar feeds are malformed in a hundred small ways and come from four
 * providers that each interpret RFC 5545 slightly differently, so this leans on
 * real-world shapes: folded lines, quoted TZID parameters, Windows time zone
 * names from Outlook, missing DTEND, and recurring standups.
 */
class IcsParserTest {

    private static final Instant FROM = Instant.parse("2026-07-27T00:00:00Z");
    private static final Instant TO = Instant.parse("2026-08-10T00:00:00Z");

    private static String wrap(String vevent) {
        return "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n" + vevent + "\r\nEND:VCALENDAR\r\n";
    }

    // --- basics --------------------------------------------------------------- //

    @Test
    @DisplayName("a simple UTC event is parsed")
    void simpleEvent() {
        List<IcsParser.CalendarEvent> events = IcsParser.parse(wrap("""
                BEGIN:VEVENT
                UID:evt-1
                SUMMARY:Sprint planning
                DTSTART:20260727T090000Z
                DTEND:20260727T100000Z
                END:VEVENT"""), FROM, TO);

        assertThat(events).hasSize(1);
        assertThat(events.get(0).title()).isEqualTo("Sprint planning");
        assertThat(events.get(0).start()).isEqualTo(Instant.parse("2026-07-27T09:00:00Z"));
        assertThat(events.get(0).end()).isEqualTo(Instant.parse("2026-07-27T10:00:00Z"));
    }

    @Test
    @DisplayName("a missing DTEND defaults to an hour rather than dropping the event")
    void missingEndDefaults() {
        List<IcsParser.CalendarEvent> events = IcsParser.parse(wrap("""
                BEGIN:VEVENT
                UID:evt-2
                SUMMARY:Quick sync
                DTSTART:20260727T090000Z
                END:VEVENT"""), FROM, TO);

        assertThat(events).hasSize(1);
        assertThat(events.get(0).end()).isEqualTo(Instant.parse("2026-07-27T10:00:00Z"));
    }

    @Test
    @DisplayName("an event with no title still renders")
    void untitledEvent() {
        List<IcsParser.CalendarEvent> events = IcsParser.parse(wrap("""
                BEGIN:VEVENT
                UID:evt-3
                DTSTART:20260727T090000Z
                END:VEVENT"""), FROM, TO);

        assertThat(events).hasSize(1);
        assertThat(events.get(0).title()).isEqualTo("(no title)");
    }

    @Test
    @DisplayName("a named time zone is converted to the right instant")
    void tzidIsApplied() {
        List<IcsParser.CalendarEvent> events = IcsParser.parse(wrap("""
                BEGIN:VEVENT
                UID:evt-4
                SUMMARY:London standup
                DTSTART;TZID=Europe/London:20260727T090000
                DTEND;TZID=Europe/London:20260727T091500
                END:VEVENT"""), FROM, TO);

        // July: London is BST (UTC+1), so 09:00 local is 08:00Z.
        assertThat(events.get(0).start()).isEqualTo(Instant.parse("2026-07-27T08:00:00Z"));
    }

    @Test
    @DisplayName("a quoted TZID parameter does not break value splitting")
    void quotedTzid() {
        // The colon inside "America/New_York" must not be read as the separator.
        List<IcsParser.CalendarEvent> events = IcsParser.parse(wrap("""
                BEGIN:VEVENT
                UID:evt-5
                SUMMARY:NY sync
                DTSTART;TZID="America/New_York":20260727T090000
                END:VEVENT"""), FROM, TO);

        assertThat(events).hasSize(1);
        assertThat(events.get(0).start()).isEqualTo(Instant.parse("2026-07-27T13:00:00Z"));
    }

    @Test
    @DisplayName("an Outlook Windows time zone name falls back to UTC instead of dropping")
    void unknownTzidFallsBack() {
        // The JDK cannot resolve "GMT Standard Time". Keeping the event at the
        // wrong offset beats losing it entirely.
        List<IcsParser.CalendarEvent> events = IcsParser.parse(wrap("""
                BEGIN:VEVENT
                UID:evt-6
                SUMMARY:Outlook meeting
                DTSTART;TZID=GMT Standard Time:20260727T090000
                END:VEVENT"""), FROM, TO);

        assertThat(events).hasSize(1);
        assertThat(events.get(0).start()).isEqualTo(Instant.parse("2026-07-27T09:00:00Z"));
    }

    @Test
    @DisplayName("an all-day event is flagged")
    void allDayEvent() {
        List<IcsParser.CalendarEvent> events = IcsParser.parse(wrap("""
                BEGIN:VEVENT
                UID:evt-7
                SUMMARY:Company offsite
                DTSTART;VALUE=DATE:20260728
                DTEND;VALUE=DATE:20260729
                END:VEVENT"""), FROM, TO);

        assertThat(events).hasSize(1);
        assertThat(events.get(0).allDay()).isTrue();
    }

    // --- lexing quirks --------------------------------------------------------- //

    @Test
    @DisplayName("folded lines are rejoined — long join links are always folded")
    void foldedLinesAreRejoined() {
        String ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:evt-8\r\n"
                + "SUMMARY:Standup\r\n"
                + "DTSTART:20260727T090000Z\r\n"
                + "LOCATION:https://zoom.us/j/9876543\r\n 21?pwd=abcdef\r\n"
                + "END:VEVENT\r\nEND:VCALENDAR\r\n";

        List<IcsParser.CalendarEvent> events = IcsParser.parse(ics, FROM, TO);

        // Without unfolding, the link would be truncated mid-URL.
        assertThat(events.get(0).meetingUrl()).isEqualTo("https://zoom.us/j/987654321?pwd=abcdef");
    }

    @Test
    @DisplayName("escaped text is unescaped")
    void textIsUnescaped() {
        List<IcsParser.CalendarEvent> events = IcsParser.parse(wrap("""
                BEGIN:VEVENT
                UID:evt-9
                SUMMARY:Planning\\, review\\; and retro
                DTSTART:20260727T090000Z
                END:VEVENT"""), FROM, TO);

        assertThat(events.get(0).title()).isEqualTo("Planning, review; and retro");
    }

    @Test
    @DisplayName("one broken event does not lose the rest of the calendar")
    void brokenEventIsSkipped() {
        List<IcsParser.CalendarEvent> events = IcsParser.parse(wrap("""
                BEGIN:VEVENT
                UID:broken
                SUMMARY:No start date at all
                END:VEVENT
                BEGIN:VEVENT
                UID:fine
                SUMMARY:Perfectly fine
                DTSTART:20260727T090000Z
                END:VEVENT"""), FROM, TO);

        assertThat(events).hasSize(1);
        assertThat(events.get(0).title()).isEqualTo("Perfectly fine");
    }

    @Test
    @DisplayName("empty and non-calendar input yields nothing rather than throwing")
    void emptyInput() {
        assertThat(IcsParser.parse(null, FROM, TO)).isEmpty();
        assertThat(IcsParser.parse("", FROM, TO)).isEmpty();
        assertThat(IcsParser.parse("<html>not a calendar</html>", FROM, TO)).isEmpty();
    }

    // --- join links ------------------------------------------------------------ //

    @Test
    @DisplayName("join links are found in LOCATION and DESCRIPTION")
    void meetingUrlsAreExtracted() {
        assertThat(IcsParser.findMeetingUrl("https://meet.google.com/abc-defg-hij", null))
                .isEqualTo("https://meet.google.com/abc-defg-hij");
        assertThat(IcsParser.findMeetingUrl(null, "Dial in or join https://zoom.us/j/123456"))
                .isEqualTo("https://zoom.us/j/123456");
        assertThat(IcsParser.findMeetingUrl("Room 4", "https://teams.microsoft.com/l/meetup-join/xyz"))
                .isEqualTo("https://teams.microsoft.com/l/meetup-join/xyz");
    }

    @Test
    @DisplayName("LOCATION wins over DESCRIPTION")
    void locationTakesPrecedence() {
        // DESCRIPTION often carries a help page or dial-in as well; LOCATION is
        // the one the calendar app treats as the link.
        assertThat(IcsParser.findMeetingUrl(
                "https://meet.google.com/real-link",
                "Having trouble? https://zoom.us/j/support"))
                .isEqualTo("https://meet.google.com/real-link");
    }

    @Test
    @DisplayName("trailing punctuation is trimmed off a link")
    void trailingPunctuationTrimmed() {
        assertThat(IcsParser.findMeetingUrl(null, "Join (https://meet.google.com/abc-defg-hij)"))
                .isEqualTo("https://meet.google.com/abc-defg-hij");
    }

    @Test
    @DisplayName("an event with no online meeting has no link")
    void noMeetingUrl() {
        assertThat(IcsParser.findMeetingUrl("Meeting room 3", "Bring the printouts")).isNull();
    }

    // --- recurrence ------------------------------------------------------------ //

    @Test
    @DisplayName("a weekday standup expands across the window")
    void weeklyByDayExpands() {
        List<IcsParser.CalendarEvent> events = IcsParser.parse(wrap("""
                BEGIN:VEVENT
                UID:standup
                SUMMARY:Daily standup
                DTSTART:20260727T090000Z
                DTEND:20260727T091500Z
                RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR
                END:VEVENT"""), FROM, Instant.parse("2026-08-03T00:00:00Z"));

        // Mon 27 Jul through Fri 31 Jul — five, with the weekend excluded.
        assertThat(events).hasSize(5);
        assertThat(events).allSatisfy(e ->
                assertThat(e.start().atZone(ZoneOffset.UTC).getDayOfWeek().getValue())
                        .isLessThanOrEqualTo(5));
    }

    @Test
    @DisplayName("COUNT caps the series")
    void countIsHonoured() {
        List<IcsParser.CalendarEvent> events = IcsParser.parse(wrap("""
                BEGIN:VEVENT
                UID:limited
                SUMMARY:Three only
                DTSTART:20260727T090000Z
                RRULE:FREQ=DAILY;COUNT=3
                END:VEVENT"""), FROM, TO);

        assertThat(events).hasSize(3);
    }

    @Test
    @DisplayName("UNTIL ends the series")
    void untilIsHonoured() {
        List<IcsParser.CalendarEvent> events = IcsParser.parse(wrap("""
                BEGIN:VEVENT
                UID:until
                SUMMARY:Until Wednesday
                DTSTART:20260727T090000Z
                RRULE:FREQ=DAILY;UNTIL=20260729T235959Z
                END:VEVENT"""), FROM, TO);

        assertThat(events).hasSize(3);   // Mon, Tue, Wed
    }

    @Test
    @DisplayName("INTERVAL skips periods")
    void intervalIsHonoured() {
        List<IcsParser.CalendarEvent> events = IcsParser.parse(wrap("""
                BEGIN:VEVENT
                UID:fortnightly
                SUMMARY:Every other day
                DTSTART:20260727T090000Z
                RRULE:FREQ=DAILY;INTERVAL=2;COUNT=3
                END:VEVENT"""), FROM, TO);

        assertThat(events).hasSize(3);
        assertThat(events.get(1).start()).isEqualTo(Instant.parse("2026-07-29T09:00:00Z"));
    }

    @Test
    @DisplayName("EXDATE removes a cancelled occurrence")
    void exdateIsHonoured() {
        List<IcsParser.CalendarEvent> events = IcsParser.parse(wrap("""
                BEGIN:VEVENT
                UID:with-exception
                SUMMARY:Daily except Tuesday
                DTSTART:20260727T090000Z
                RRULE:FREQ=DAILY;COUNT=3
                EXDATE:20260728T090000Z
                END:VEVENT"""), FROM, TO);

        assertThat(events).hasSize(2);
        assertThat(events).noneSatisfy(e ->
                assertThat(e.start()).isEqualTo(Instant.parse("2026-07-28T09:00:00Z")));
    }

    @Test
    @DisplayName("a MONTHLY rule degrades to one occurrence rather than a wrong series")
    void unsupportedRuleDegradesSafely() {
        // Stated limitation: MONTHLY is not expanded. Showing one real event is
        // honest; inventing a series on the wrong days would not be.
        List<IcsParser.CalendarEvent> events = IcsParser.parse(wrap("""
                BEGIN:VEVENT
                UID:monthly
                SUMMARY:Monthly review
                DTSTART:20260727T090000Z
                RRULE:FREQ=MONTHLY;BYMONTHDAY=27
                END:VEVENT"""), FROM, TO);

        assertThat(events).hasSize(1);
    }

    @Test
    @DisplayName("an unbounded daily rule cannot run away")
    void unboundedRuleIsBounded() {
        List<IcsParser.CalendarEvent> events = IcsParser.parse(wrap("""
                BEGIN:VEVENT
                UID:forever
                SUMMARY:Forever
                DTSTART:20260727T090000Z
                RRULE:FREQ=DAILY
                END:VEVENT"""), FROM, FROM.plus(14, ChronoUnit.DAYS));

        assertThat(events).hasSize(14);
    }

    // --- windowing -------------------------------------------------------------- //

    @Test
    @DisplayName("events outside the window are excluded")
    void outsideWindowExcluded() {
        List<IcsParser.CalendarEvent> events = IcsParser.parse(wrap("""
                BEGIN:VEVENT
                UID:old
                SUMMARY:Last year
                DTSTART:20250727T090000Z
                END:VEVENT"""), FROM, TO);

        assertThat(events).isEmpty();
    }

    @Test
    @DisplayName("a meeting already in progress is still included")
    void inProgressMeetingIncluded() {
        // Overlap, not containment: this is exactly the meeting someone opens
        // Recallix to start recording.
        List<IcsParser.CalendarEvent> events = IcsParser.parse(wrap("""
                BEGIN:VEVENT
                UID:running
                SUMMARY:Already started
                DTSTART:20260726T230000Z
                DTEND:20260727T010000Z
                END:VEVENT"""), FROM, TO);

        assertThat(events).hasSize(1);
    }

    @Test
    @DisplayName("results are ordered earliest first")
    void resultsAreSorted() {
        List<IcsParser.CalendarEvent> events = IcsParser.parse(wrap("""
                BEGIN:VEVENT
                UID:later
                SUMMARY:Later
                DTSTART:20260729T090000Z
                END:VEVENT
                BEGIN:VEVENT
                UID:earlier
                SUMMARY:Earlier
                DTSTART:20260727T090000Z
                END:VEVENT"""), FROM, TO);

        assertThat(events).extracting(IcsParser.CalendarEvent::title)
                .containsExactly("Earlier", "Later");
    }
}
