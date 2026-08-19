package com.recallix.service;

import com.recallix.entity.Meeting;
import com.recallix.entity.UserEntity;
import com.recallix.event.WorkspaceActivityEvent;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.time.LocalDate;
import java.util.Optional;

import static com.recallix.event.WorkspaceActivityEvent.Kind.COMMENT_ADDED;
import static com.recallix.event.WorkspaceActivityEvent.Kind.HIGHLIGHT_ADDED;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The two activity emails.
 *
 * <p>Every test here is about not sending. That is the shape of the risk: both
 * describe something the reader did themselves, so the way they fail is
 * not silence, it is volume — an afternoon of highlighting a transcript turning
 * into forty messages, which is how somebody writes a filter rule and stops
 * reading the sender for good.
 *
 * <p>The second thing under test is that the stamp is only written when the mail
 * actually left. A stamp written on a failed send costs somebody the day's one
 * message for a mail server that was down for a minute.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ActivityEmailServiceTest {

    private static final String USER = "usr_1";
    private static final String MEETING = "mtg_1";
    private static final LocalDate TODAY = LocalDate.of(2026, 8, 18);

    @Mock private UserRepository users;
    @Mock private MeetingRepository meetings;
    @Mock private EmailService email;

    private ActivityEmailService service;
    private UserEntity user;

    @BeforeEach
    void setUp() {
        service = new ActivityEmailService(users, meetings, email, "http://localhost:3000/");

        user = new UserEntity();
        user.setId(USER);
        user.setEmail("ana@example.com");
        // Both switches on, so each test can turn off only the one it is about.
        user.setCommentEmail(true);
        user.setHighlightEmail(true);

        Meeting meeting = new Meeting();
        meeting.setId(MEETING);
        meeting.setUserId(USER);
        meeting.setTitle("Sprint planning");

        when(users.findById(USER)).thenReturn(Optional.of(user));
        when(meetings.findById(MEETING)).thenReturn(Optional.of(meeting));
        when(email.send(anyString(), anyString(), anyString())).thenReturn(true);
    }

    private static WorkspaceActivityEvent comment(String body) {
        return new WorkspaceActivityEvent(USER, COMMENT_ADDED, "ai_1", body);
    }

    private static WorkspaceActivityEvent highlight(String quote) {
        return new WorkspaceActivityEvent(USER, HIGHLIGHT_ADDED, MEETING, quote);
    }

    private String bodySent() {
        ArgumentCaptor<String> body = ArgumentCaptor.forClass(String.class);
        verify(email).send(anyString(), anyString(), body.capture());
        return body.getValue();
    }

    private String subjectSent() {
        ArgumentCaptor<String> subject = ArgumentCaptor.forClass(String.class);
        verify(email).send(anyString(), subject.capture(), anyString());
        return subject.getValue();
    }

    @Nested
    @DisplayName("what stops a message")
    class Gates {

        @Test
        @DisplayName("the master switch silences both")
        void masterSilencesEverything() {
            user.setEmailsEnabled(false);

            assertThat(service.send(comment("Looks fine"), TODAY)).isFalse();
            assertThat(service.send(highlight("the bit that mattered"), TODAY)).isFalse();
            verify(email, never()).send(anyString(), anyString(), anyString());
        }

        @Test
        @DisplayName("each switch governs only its own message")
        void switchesAreNotCrossed() {
            user.setCommentEmail(false);

            assertThat(service.send(comment("Looks fine"), TODAY)).isFalse();
            assertThat(service.send(highlight("the bit that mattered"), TODAY)).isTrue();
        }

        @Test
        @DisplayName("an account with nowhere to send is skipped, not crashed on")
        void noAddressIsNotAnError() {
            user.setEmail(null);

            assertThat(service.send(highlight("anything"), TODAY)).isFalse();
            verify(email, never()).send(anyString(), anyString(), anyString());
        }

        @Test
        @DisplayName("an account that no longer exists is skipped")
        void missingUserIsNotAnError() {
            when(users.findById(USER)).thenReturn(Optional.empty());

            assertThat(service.send(highlight("anything"), TODAY)).isFalse();
        }
    }

    @Nested
    @DisplayName("one a day")
    class DailyLimit {

        @Test
        @DisplayName("the second highlight of the day is silent")
        void highlightsCollapseToOne() {
            assertThat(service.send(highlight("first"), TODAY)).isTrue();
            assertThat(service.send(highlight("second"), TODAY)).isFalse();
            assertThat(service.send(highlight("third"), TODAY)).isFalse();

            verify(email).send(anyString(), anyString(), anyString());
        }

        @Test
        @DisplayName("tomorrow starts again")
        void theLimitIsPerDay() {
            service.send(highlight("first"), TODAY);

            assertThat(service.send(highlight("next day"), TODAY.plusDays(1))).isTrue();
        }

        @Test
        @DisplayName("comments and highlights do not spend each other's allowance")
        void theTwoStampsAreSeparate() {
            assertThat(service.send(highlight("a passage"), TODAY)).isTrue();
            assertThat(service.send(comment("a note"), TODAY)).isTrue();
        }

        @Test
        @DisplayName("a send that failed does not spend the day")
        void aFailedSendIsNotStamped() {
            when(email.send(anyString(), anyString(), anyString())).thenReturn(false);
            assertThat(service.send(highlight("first"), TODAY)).isFalse();
            assertThat(user.getHighlightEmailedOn()).isNull();

            // An SMTP server that was down for a minute must not cost the day.
            when(email.send(anyString(), anyString(), anyString())).thenReturn(true);
            assertThat(service.send(highlight("retry"), TODAY)).isTrue();
        }

        @Test
        @DisplayName("the message says it is the only one coming")
        void theMessageAdmitsTheLimit() {
            service.send(highlight("a passage"), TODAY);

            // Otherwise the silence afterwards reads as the switch breaking.
            assertThat(bodySent()).contains("only highlight email today");
        }
    }

    @Nested
    @DisplayName("what the messages say")
    class Wording {

        @Test
        @DisplayName("a highlight names the meeting it came from")
        void highlightNamesTheMeeting() {
            service.send(highlight("the bit that mattered"), TODAY);

            assertThat(subjectSent()).contains("Sprint planning");
            assertThat(bodySent()).contains("the bit that mattered")
                    .contains("/meetings/" + MEETING);
        }

        @Test
        @DisplayName("a highlight on a meeting that has since gone still sends")
        void aMissingMeetingIsNotAFailure() {
            when(meetings.findById(MEETING)).thenReturn(Optional.empty());

            assertThat(service.send(highlight("something"), TODAY)).isTrue();
            assertThat(subjectSent()).contains("a conversation");
        }

        @Test
        @DisplayName("a long quote is cut rather than reproduced whole")
        void longQuotesAreTrimmed() {
            // Sending the passage in full removes the reason to open the
            // meeting, which is where the surrounding minute actually is.
            String long_ = "word ".repeat(200);
            service.send(highlight(long_), TODAY);

            assertThat(bodySent()).contains("…");
            assertThat(bodySent().length()).isLessThan(long_.length());
        }

        @Test
        @DisplayName("every message names the switch that sent it")
        void eachNamesItsOwnSwitch() {
            service.send(highlight("a passage"), TODAY);
            assertThat(bodySent()).contains("\"Highlights\"").contains("Account Settings");
        }

        @Test
        @DisplayName("a comment with an empty body still sends, without an empty quote")
        void anEmptyBodyIsNotQuoted() {
            assertThat(service.send(comment(""), TODAY)).isTrue();
            assertThat(bodySent()).doesNotContain("\"\"");
        }
    }
}
