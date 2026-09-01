package com.reverie.common;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.time.LocalDate;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Reading a spoken deadline as a date.
 *
 * <p>Half of these tests are about what it refuses, and that is the important
 * half. Everything this class resolves becomes a badge, a filter and eventually
 * an email at seven in the morning, so a date invented out of "before the demo"
 * does not degrade quietly — it tells somebody they are late for a deadline
 * nobody set, and the second time it happens they stop believing the first.
 */
class DueDatesTest {

    /** A Wednesday, chosen so "this Wednesday" and "next Wednesday" differ. */
    private static final LocalDate WEDNESDAY = LocalDate.of(2026, 8, 12);

    private static LocalDate on(String spoken) {
        return DueDates.resolve(spoken, WEDNESDAY);
    }

    @Nested
    class Refusing {

        @ParameterizedTest
        @ValueSource(strings = {
                "before the demo", "next sprint", "asap", "soon", "when we have time",
                "tbd", "after the release", "q3", "", "   ",
        })
        @DisplayName("phrasing that names no day resolves to nothing")
        void refusesVagueness(String spoken) {
            assertThat(on(spoken)).isNull();
        }

        @ParameterizedTest
        @ValueSource(strings = {"3/4", "03/04/2026", "4-3", "12.08.2026"})
        @DisplayName("a bare numeric date is refused, because it has two readings")
        void refusesAmbiguousNumbers(String spoken) {
            // A reader in Boston and a reader in London disagree about which
            // number is the month, and nothing in a transcript settles it.
            assertThat(on(spoken)).isNull();
        }

        @Test
        @DisplayName("a well-shaped date that never happened is not a date")
        void refusesImpossibleDays() {
            assertThat(on("2026-02-31")).isNull();
            assertThat(on("31 february")).isNull();
            assertThat(on("29 february")).isNull(); // 2026 is not a leap year
        }

        @Test
        @DisplayName("nothing resolves without a meeting to resolve it against")
        void needsAReference() {
            assertThat(DueDates.resolve("friday", null)).isNull();
            assertThat(DueDates.resolve(null, WEDNESDAY)).isNull();
        }
    }

    @Nested
    class Absolute {

        @Test
        @DisplayName("an ISO date is taken as written")
        void iso() {
            assertThat(on("2026-08-20")).isEqualTo(LocalDate.of(2026, 8, 20));
        }

        @Test
        @DisplayName("a month by name is unambiguous either way round")
        void monthNames() {
            assertThat(on("20 august")).isEqualTo(LocalDate.of(2026, 8, 20));
            assertThat(on("August 20")).isEqualTo(LocalDate.of(2026, 8, 20));
            assertThat(on("Aug 20th")).isEqualTo(LocalDate.of(2026, 8, 20));
            assertThat(on("aug 20, 2027")).isEqualTo(LocalDate.of(2027, 8, 20));
        }

        @Test
        @DisplayName("a date just gone is the past, not next year")
        void recentPastStaysPast() {
            // Said on the 12th, "the 1st" was eleven days ago and the task is
            // late. Rolling it forward would hide an overdue item for a year.
            assertThat(on("1 august")).isEqualTo(LocalDate.of(2026, 8, 1));
        }

        @Test
        @DisplayName("a date long gone is next year's")
        void distantPastRollsForward() {
            assertThat(on("1 march")).isEqualTo(LocalDate.of(2027, 3, 1));
        }
    }

    @Nested
    class Relative {

        @Test
        @DisplayName("the everyday words")
        void plainWords() {
            assertThat(on("today")).isEqualTo(WEDNESDAY);
            assertThat(on("tomorrow")).isEqualTo(WEDNESDAY.plusDays(1));
            assertThat(on("end of day")).isEqualTo(WEDNESDAY);
            assertThat(on("EOD")).isEqualTo(WEDNESDAY);
        }

        @Test
        @DisplayName("a weekday is the next one, counted from the meeting")
        void weekdays() {
            assertThat(on("friday")).isEqualTo(LocalDate.of(2026, 8, 14));
            assertThat(on("monday")).isEqualTo(LocalDate.of(2026, 8, 17));
        }

        @Test
        @DisplayName("the day the meeting fell on means a week away")
        void sameWeekdayIsNextWeek() {
            // Nobody says "Wednesday" in a Wednesday meeting to mean the meeting
            // they are currently in.
            assertThat(on("wednesday")).isEqualTo(LocalDate.of(2026, 8, 19));
        }

        @Test
        @DisplayName("\"next Friday\" is read as the coming Friday")
        void nextIsTheNearOne() {
            // Genuinely ambiguous in English. The near reading is the common one
            // and being wrong costs a week rather than the other way round.
            assertThat(on("next friday")).isEqualTo(LocalDate.of(2026, 8, 14));
            assertThat(on("this friday")).isEqualTo(LocalDate.of(2026, 8, 14));
        }

        @Test
        @DisplayName("counted offsets")
        void offsets() {
            assertThat(on("in 3 days")).isEqualTo(LocalDate.of(2026, 8, 15));
            assertThat(on("in 2 weeks")).isEqualTo(LocalDate.of(2026, 8, 26));
            assertThat(on("next week")).isEqualTo(LocalDate.of(2026, 8, 19));
        }

        @Test
        @DisplayName("end of week is that Friday; end of month is the last day")
        void endsOfThings() {
            assertThat(on("end of week")).isEqualTo(LocalDate.of(2026, 8, 14));
            assertThat(on("end of month")).isEqualTo(LocalDate.of(2026, 8, 31));
        }

        @Test
        @DisplayName("everything is relative to the meeting, never to today")
        void anchoredToTheMeeting() {
            LocalDate old = LocalDate.of(2020, 1, 6); // a Monday
            assertThat(DueDates.resolve("friday", old)).isEqualTo(LocalDate.of(2020, 1, 10));
        }
    }

    @Nested
    class Noise {

        @Test
        @DisplayName("prepositions are not part of the date")
        void stripsLeadIns() {
            LocalDate friday = LocalDate.of(2026, 8, 14);
            assertThat(on("by friday")).isEqualTo(friday);
            assertThat(on("due by Friday")).isEqualTo(friday);
            assertThat(on("before friday")).isEqualTo(friday);
            assertThat(on("end of day friday")).isEqualTo(friday);
            assertThat(on("no later than friday")).isEqualTo(friday);
        }

        @Test
        @DisplayName("a time of day does not make it a different day")
        void stripsClockTimes() {
            LocalDate friday = LocalDate.of(2026, 8, 14);
            assertThat(on("friday morning")).isEqualTo(friday);
            assertThat(on("friday at 5")).isEqualTo(friday);
            assertThat(on("friday 5pm")).isEqualTo(friday);
            assertThat(on("tomorrow evening")).isEqualTo(WEDNESDAY.plusDays(1));
        }

        @Test
        @DisplayName("casing, spacing and trailing punctuation are ignored")
        void tolerantOfShape() {
            assertThat(on("  FRIDAY.  ")).isEqualTo(LocalDate.of(2026, 8, 14));
            assertThat(on("Next  Monday")).isEqualTo(LocalDate.of(2026, 8, 17));
        }
    }
}
