package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingActionItem;
import com.recallix.entity.UserEntity;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

/**
 * The calendar feed.
 *
 * <p>An ICS file is read by software nobody controls, which makes it unusually
 * unforgiving: a stray comma in a task title, a line folded through the middle
 * of a multi-byte character, a UID that changes between fetches — each renders
 * as either a rejected calendar or a silent daily churn of deleted and recreated
 * events, and none of it is visible from inside Recallix.
 *
 * <p>The other half is that the URL is the credential. It has to be unguessable,
 * it has to be rotatable, and rotating it has to actually break the old one.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class CalendarFeedServiceTest {

    private static final String USER = "usr_1";

    @Mock private UserRepository users;
    @Mock private MeetingActionItemRepository actionItems;
    @Mock private MeetingRepository meetings;

    private CalendarFeedService service;
    private UserEntity user;

    @BeforeEach
    void setUp() {
        service = new CalendarFeedService(users, actionItems, meetings,
                "https://api.recallix.test/", "https://recallix.test/");
        user = new UserEntity();
        user.setId(USER);
        when(users.findById(USER)).thenReturn(Optional.of(user));
        when(actionItems.findDueThrough(anyString(), any(LocalDate.class))).thenReturn(List.of());
        when(meetings.findAllById(any())).thenReturn(List.of());
    }

    private static MeetingActionItem task(String id, String title, LocalDate due) {
        MeetingActionItem item = new MeetingActionItem();
        item.setId(id);
        item.setUserId(USER);
        item.setMeetingId("mtg_1");
        item.setTitle(title);
        item.setDueOn(due);
        item.setStatus("OPEN");
        return item;
    }

    private String feedFor(MeetingActionItem... tasks) {
        user.setCalendarToken("tok");
        when(users.findByCalendarToken("tok")).thenReturn(Optional.of(user));
        when(actionItems.findDueThrough(anyString(), any(LocalDate.class))).thenReturn(List.of(tasks));
        return service.render("tok");
    }

    @Nested
    @DisplayName("the switch")
    class Switch {

        @Test
        @DisplayName("is off until somebody asks, so no account carries an unused secret")
        void offByDefault() {
            CalendarFeedService.Feed feed = service.status(USER);

            assertThat(feed.enabled()).isFalse();
            assertThat(feed.url()).isNull();
        }

        @Test
        @DisplayName("hands back both forms of the URL, because the two ways of subscribing differ")
        void bothUrls() {
            CalendarFeedService.Feed feed = service.enable(USER);

            assertThat(feed.enabled()).isTrue();
            assertThat(feed.url()).startsWith("https://api.recallix.test/public/calendar/");
            assertThat(feed.url()).endsWith(".ics");
            assertThat(feed.webcalUrl()).startsWith("webcal://api.recallix.test/public/calendar/");
        }

        @Test
        @DisplayName("mints a token nobody could guess, and never the same one twice")
        void unguessable() {
            String first = service.enable(USER).url();
            String second = service.enable(USER).url();

            assertThat(first).isNotEqualTo(second);
            // 24 bytes, URL-safe base64, no padding.
            assertThat(user.getCalendarToken()).hasSize(32);
            assertThat(user.getCalendarToken()).doesNotContain(USER);
        }

        @Test
        @DisplayName("rotating really does break the old URL")
        void rotatingRevokes() {
            String old = service.enable(USER).url();
            service.enable(USER);

            String oldToken = old.substring(old.lastIndexOf('/') + 1, old.length() - 4);
            when(users.findByCalendarToken(oldToken)).thenReturn(Optional.empty());
            assertThatThrownBy(() -> service.render(oldToken)).isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("turning it off leaves nothing to resolve")
        void disabling() {
            service.enable(USER);
            service.disable(USER);

            assertThat(user.getCalendarToken()).isNull();
            assertThat(service.status(USER).enabled()).isFalse();
        }
    }

    @Nested
    @DisplayName("the file")
    class File {

        @Test
        @DisplayName("is a calendar every reader will accept")
        void wellFormed() {
            String ics = feedFor(task("ai_1", "Send the deck", LocalDate.now(ZoneOffset.UTC).plusDays(2)));

            assertThat(ics).startsWith("BEGIN:VCALENDAR\r\n");
            assertThat(ics).endsWith("END:VCALENDAR\r\n");
            assertThat(ics).contains("VERSION:2.0");
            // CRLF, not LF. Half the readers in the world are strict about it.
            assertThat(ics).doesNotContain("\n\n");
        }

        @Test
        @DisplayName("puts a deadline on its day as an all-day event, ending the next")
        void allDay() {
            LocalDate due = LocalDate.of(2026, 8, 21);
            String ics = feedFor(task("ai_1", "Send the deck", due));

            assertThat(ics).contains("DTSTART;VALUE=DATE:20260821");
            // Exclusive end, per RFC 5545. Without the +1 the event has no length
            // and several readers drop it.
            assertThat(ics).contains("DTEND;VALUE=DATE:20260822");
        }

        @Test
        @DisplayName("does not make anybody busy — a deadline is not an appointment")
        void transparent() {
            String ics = feedFor(task("ai_1", "Send the deck", LocalDate.now(ZoneOffset.UTC)));

            assertThat(ics).contains("TRANSP:TRANSPARENT");
        }

        @Test
        @DisplayName("keeps a stable UID, so a refresh does not recreate every event")
        void stableUid() {
            LocalDate due = LocalDate.now(ZoneOffset.UTC).plusDays(1);
            String first = feedFor(task("ai_1", "Send the deck", due));
            String second = feedFor(task("ai_1", "Send the deck", due));

            assertThat(first).contains("UID:ai_1@recallix");
            assertThat(second).contains("UID:ai_1@recallix");
        }

        @Test
        @DisplayName("leads with the owner, because a shared calendar has several")
        void ownerFirst() {
            MeetingActionItem item = task("ai_1", "Send the deck", LocalDate.now(ZoneOffset.UTC));
            item.setOwnerName("Priya");

            assertThat(feedFor(item)).contains("SUMMARY:Priya: Send the deck");
        }

        @Test
        @DisplayName("links back to the meeting the promise was made in")
        void linksBack() {
            Meeting meeting = new Meeting();
            meeting.setId("mtg_1");
            meeting.setTitle("Sprint planning");
            when(meetings.findAllById(any())).thenReturn(List.of(meeting));

            String ics = feedFor(task("ai_1", "Send the deck", LocalDate.now(ZoneOffset.UTC)));

            assertThat(ics).contains("URL:https://recallix.test/meetings/mtg_1?tab=actions");
            assertThat(ics).contains("From: Sprint planning");
        }

        @Test
        @DisplayName("says so when a task was typed rather than said")
        void standaloneSaysSo() {
            MeetingActionItem typed = task("ai_1", "Write the migration", LocalDate.now(ZoneOffset.UTC));
            typed.setMeetingId(null);

            String ics = feedFor(typed);

            assertThat(ics).contains("Added by hand in Recallix.");
            // Home, since the tracker page is gone. A typed task has no meeting
            // to open, and the panel beside the chat is where it was typed and
            // where it is ticked off. An item out of a transcript still opens
            // its own meeting — the case above this one.
            assertThat(ics).contains("URL:https://recallix.test/home");
        }

        @Test
        @DisplayName("reminds the day before, rather than at an hour we invented")
        void remindsTheDayBefore() {
            String ics = feedFor(task("ai_1", "Send the deck", LocalDate.now(ZoneOffset.UTC).plusDays(3)));

            assertThat(ics).contains("BEGIN:VALARM");
            assertThat(ics).contains("TRIGGER:-P1D");
        }

        @Test
        @DisplayName("leaves out what fell off the back of the window")
        void dropsAncientDeadlines() {
            LocalDate old = LocalDate.now(ZoneOffset.UTC).minusDays(200);

            assertThat(feedFor(task("ai_1", "Ancient", old))).doesNotContain("Ancient");
        }

        @Test
        @DisplayName("keeps a recent one, because a calendar is a record of a period")
        void keepsRecentDeadlines() {
            LocalDate lastWeek = LocalDate.now(ZoneOffset.UTC).minusDays(7);

            assertThat(feedFor(task("ai_1", "Last week", lastWeek))).contains("Last week");
        }

        @Test
        @DisplayName("is empty and still valid when there is nothing due")
        void emptyIsStillACalendar() {
            user.setCalendarToken("tok");
            when(users.findByCalendarToken("tok")).thenReturn(Optional.of(user));

            String ics = service.render("tok");

            assertThat(ics).contains("BEGIN:VCALENDAR");
            assertThat(ics).doesNotContain("BEGIN:VEVENT");
        }

        @Test
        @DisplayName("a token nobody issued resolves to nothing")
        void unknownToken() {
            when(users.findByCalendarToken("nope")).thenReturn(Optional.empty());

            assertThatThrownBy(() -> service.render("nope")).isInstanceOf(ApiException.class);
        }
    }

    @Nested
    @DisplayName("escaping, which is where calendars actually break")
    class Escaping {

        @Test
        @DisplayName("escapes the three characters that are separators in ICS")
        void separators() {
            assertThat(CalendarFeedService.escape("Ask Marcus, then confirm"))
                    .isEqualTo("Ask Marcus\\, then confirm");
            assertThat(CalendarFeedService.escape("a;b")).isEqualTo("a\\;b");
        }

        @Test
        @DisplayName("escapes the backslash first, or every other rule doubles it")
        void backslashFirst() {
            // Done last, `C:\path, x` would arrive with a stray character in
            // every reader that parsed it.
            assertThat(CalendarFeedService.escape("a\\b,c")).isEqualTo("a\\\\b\\,c");
        }

        @Test
        @DisplayName("carries a newline as the two characters ICS expects")
        void newlines() {
            assertThat(CalendarFeedService.escape("one\ntwo")).isEqualTo("one\\ntwo");
            assertThat(CalendarFeedService.escape("one\r\ntwo")).isEqualTo("one\\ntwo");
        }

        @Test
        @DisplayName("survives nothing at all")
        void nullIsEmpty() {
            assertThat(CalendarFeedService.escape(null)).isEmpty();
        }
    }

    @Nested
    @DisplayName("folding")
    class Folding {

        @Test
        @DisplayName("leaves a short line alone")
        void shortLine() {
            StringBuilder out = new StringBuilder();
            CalendarFeedService.line(out, "SUMMARY:Send the deck");

            assertThat(out.toString()).isEqualTo("SUMMARY:Send the deck\r\n");
        }

        @Test
        @DisplayName("folds a long one with the leading space a reader expects")
        void longLine() {
            StringBuilder out = new StringBuilder();
            CalendarFeedService.line(out, "SUMMARY:" + "x".repeat(200));

            String[] lines = out.toString().split("\r\n");
            assertThat(lines.length).isGreaterThan(1);
            assertThat(lines[0].length()).isLessThanOrEqualTo(73);
            assertThat(lines[1]).startsWith(" ");
        }

        @Test
        @DisplayName("never splits a multi-byte character in half")
        void multiByte() {
            // A split through a UTF-8 sequence produces two invalid bytes, which
            // is how a calendar full of names in Hindi or Japanese gets rejected
            // wholesale by a reader that was happy with the ASCII one.
            StringBuilder out = new StringBuilder();
            CalendarFeedService.line(out, "SUMMARY:" + "四半期レビュー".repeat(12));

            String folded = out.toString();
            byte[] bytes = folded.getBytes(StandardCharsets.UTF_8);
            assertThat(new String(bytes, StandardCharsets.UTF_8)).isEqualTo(folded);
            assertThat(folded).doesNotContain("\uFFFD");
        }
    }
}
