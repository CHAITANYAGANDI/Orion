package com.recallix.service;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The parser against a real provider feed rather than hand-written fixtures.
 *
 * <p>The fixture is a genuine Google Calendar export (the UK holidays feed,
 * trimmed to 2026), kept because hand-written ICS tends to be tidier than what
 * providers actually emit — this one folds long DESCRIPTION lines mid-word,
 * escapes commas, and uses VALUE=DATE for every event. Those are exactly the
 * shapes that break a parser written only against the spec.
 */
class IcsParserRealFeedTest {

    private static String feed() throws IOException {
        try (InputStream in = IcsParserRealFeedTest.class
                .getResourceAsStream("/google-uk-holidays-2026.ics")) {
            assertThat(in).as("fixture on the test classpath").isNotNull();
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    @Test
    @DisplayName("a real Google feed parses")
    void realFeedParses() throws IOException {
        List<IcsParser.CalendarEvent> events = IcsParser.parse(
                feed(),
                Instant.parse("2026-01-01T00:00:00Z"),
                Instant.parse("2027-01-01T00:00:00Z"));

        assertThat(events).isNotEmpty();
        assertThat(events).extracting(IcsParser.CalendarEvent::title)
                .contains("Good Friday", "Christmas Day");
    }

    @Test
    @DisplayName("Google's all-day events are flagged as such")
    void allDayEventsAreFlagged() throws IOException {
        List<IcsParser.CalendarEvent> events = IcsParser.parse(
                feed(),
                Instant.parse("2026-12-24T00:00:00Z"),
                Instant.parse("2026-12-27T00:00:00Z"));

        assertThat(events).isNotEmpty();
        assertThat(events).allMatch(IcsParser.CalendarEvent::allDay);
    }

    @Test
    @DisplayName("the window actually narrows the result")
    void windowNarrowsResults() throws IOException {
        String ics = feed();
        int wholeYear = IcsParser.parse(ics,
                Instant.parse("2026-01-01T00:00:00Z"),
                Instant.parse("2027-01-01T00:00:00Z")).size();
        int oneWeek = IcsParser.parse(ics,
                Instant.parse("2026-12-24T00:00:00Z"),
                Instant.parse("2026-12-31T00:00:00Z")).size();

        assertThat(oneWeek).isPositive().isLessThan(wholeYear);
    }

    @Test
    @DisplayName("escaped commas in Google's DESCRIPTION do not corrupt the title")
    void escapedTextSurvives() throws IOException {
        List<IcsParser.CalendarEvent> events = IcsParser.parse(
                feed(),
                Instant.parse("2026-01-01T00:00:00Z"),
                Instant.parse("2027-01-01T00:00:00Z"));

        // Nothing should carry a stray backslash out of the escaping pass.
        assertThat(events).extracting(IcsParser.CalendarEvent::title)
                .allSatisfy(t -> assertThat(t).doesNotContain("\\"));
    }

    @Test
    @DisplayName("holiday entries carry no join link")
    void holidaysHaveNoMeetingUrl() throws IOException {
        List<IcsParser.CalendarEvent> events = IcsParser.parse(
                feed(),
                Instant.parse("2026-01-01T00:00:00Z"),
                Instant.parse("2027-01-01T00:00:00Z"));

        // The URL matcher must not fire on the Google settings link that this
        // feed puts in DESCRIPTION.
        assertThat(events).allSatisfy(e -> assertThat(e.meetingUrl()).isNull());
    }
}
