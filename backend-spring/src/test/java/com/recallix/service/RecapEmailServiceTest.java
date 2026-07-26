package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.dto.EmailDraftResponse;
import com.recallix.entity.Meeting;
import com.recallix.entity.UserEntity;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.time.Instant;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Automatic recap email.
 *
 * <p>The failure modes worth guarding are all about sending: mailing someone
 * who never asked, mailing the same recap twice because a reprocess re-fired
 * the ready event, or failing a completed meeting because an SMTP server was
 * unreachable. Nearly every test here asserts that nothing was sent.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class RecapEmailServiceTest {

    private static final String USER = "usr_1";
    private static final String MEETING = "mtg_1";

    @Mock private MeetingRepository meetings;
    @Mock private UserRepository users;
    @Mock private FollowUpService followUp;
    @Mock private EmailService email;
    @Mock private AuditService audit;

    private RecapEmailService service;
    private Meeting meeting;

    @BeforeEach
    void setUp() {
        service = new RecapEmailService(meetings, users, followUp, email, audit);
        meeting = new Meeting();
        meeting.setId(MEETING);
        meeting.setUserId(USER);
        meeting.setTitle("Sprint planning");

        when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(meeting));
        when(users.findById(USER)).thenReturn(Optional.of(user(true, null, "ana@example.com")));
        when(followUp.draft(USER, MEETING))
                .thenReturn(new EmailDraftResponse("Recap: Sprint planning", "We decided X."));
        when(email.send(anyString(), anyString(), anyString())).thenReturn(true);
    }

    // --- opt-in --------------------------------------------------------------- //

    @Test
    @DisplayName("nothing is sent unless the user opted in")
    void optedOutUserGetsNothing() {
        when(users.findById(USER)).thenReturn(Optional.of(user(false, null, "ana@example.com")));

        assertThat(service.sendIfEnabled(MEETING, USER)).isFalse();
        verify(email, never()).send(anyString(), anyString(), anyString());
        // Drafting costs an AI call — it must not happen either.
        verify(followUp, never()).draft(anyString(), anyString());
    }

    @Test
    @DisplayName("an opted-in user gets the recap")
    void optedInUserGetsTheRecap() {
        assertThat(service.sendIfEnabled(MEETING, USER)).isTrue();
        verify(email).send(anyString(), anyString(), anyString());
    }

    @Test
    @DisplayName("an unknown user is a no-op rather than an error")
    void unknownUserIsIgnored() {
        when(users.findById(USER)).thenReturn(Optional.empty());
        assertThat(service.sendIfEnabled(MEETING, USER)).isFalse();
    }

    // --- destination ---------------------------------------------------------- //

    @Test
    @DisplayName("the recap goes to the account email by default")
    void defaultsToTheAccountAddress() {
        service.sendIfEnabled(MEETING, USER);

        ArgumentCaptor<String> to = ArgumentCaptor.forClass(String.class);
        verify(email).send(to.capture(), anyString(), anyString());
        assertThat(to.getValue()).isEqualTo("ana@example.com");
    }

    @Test
    @DisplayName("an override address wins over the account email")
    void overrideAddressWins() {
        when(users.findById(USER))
                .thenReturn(Optional.of(user(true, "notes@example.com", "ana@example.com")));

        service.sendIfEnabled(MEETING, USER);

        ArgumentCaptor<String> to = ArgumentCaptor.forClass(String.class);
        verify(email).send(to.capture(), anyString(), anyString());
        assertThat(to.getValue()).isEqualTo("notes@example.com");
    }

    @Test
    @DisplayName("no address on file means nothing is sent")
    void missingAddressSendsNothing() {
        when(users.findById(USER)).thenReturn(Optional.of(user(true, null, null)));

        assertThat(service.sendIfEnabled(MEETING, USER)).isFalse();
        verify(email, never()).send(anyString(), anyString(), anyString());
    }

    // --- send-once ------------------------------------------------------------ //

    @Test
    @DisplayName("reprocessing does not send the recap a second time")
    void alreadySentIsNotResent() {
        meeting.setRecapSentAt(Instant.now().minusSeconds(3600));

        assertThat(service.sendIfEnabled(MEETING, USER)).isFalse();
        verify(email, never()).send(anyString(), anyString(), anyString());
    }

    @Test
    @DisplayName("a successful send is stamped so the next ready event skips it")
    void successfulSendIsStamped() {
        service.sendIfEnabled(MEETING, USER);
        assertThat(meeting.getRecapSentAt()).isNotNull();
    }

    @Test
    @DisplayName("a failed send stays eligible for a later retry")
    void failedSendIsNotStamped() {
        when(email.send(anyString(), anyString(), anyString())).thenReturn(false);

        assertThat(service.sendIfEnabled(MEETING, USER)).isFalse();
        // Unstamped means a reprocess can still deliver it.
        assertThat(meeting.getRecapSentAt()).isNull();
        verify(audit, never()).record(anyString(), anyString(), anyString(), anyString());
    }

    // --- resilience ----------------------------------------------------------- //

    @Test
    @DisplayName("a meeting with no brief is skipped quietly")
    void meetingWithoutABriefIsSkipped() {
        when(followUp.draft(USER, MEETING))
                .thenThrow(ApiException.badRequest("This meeting has no brief to draft from yet"));

        assertThat(service.sendIfEnabled(MEETING, USER)).isFalse();
        verify(email, never()).send(anyString(), anyString(), anyString());
    }

    @Test
    @DisplayName("a drafting failure never propagates to the caller")
    void draftFailureIsContained() {
        when(followUp.draft(USER, MEETING)).thenThrow(new RuntimeException("ai-service down"));

        // The meeting is already processed and usable; this must not blow up.
        assertThat(service.sendIfEnabled(MEETING, USER)).isFalse();
    }

    @Test
    @DisplayName("another user's meeting is never mailed")
    void foreignMeetingIsRefused() {
        when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.empty());

        assertThat(service.sendIfEnabled(MEETING, USER)).isFalse();
        verify(email, never()).send(anyString(), anyString(), anyString());
    }

    @Test
    @DisplayName("the body says how to turn recaps off")
    void bodyExplainsHowToStop() {
        service.sendIfEnabled(MEETING, USER);

        ArgumentCaptor<String> body = ArgumentCaptor.forClass(String.class);
        verify(email).send(anyString(), anyString(), body.capture());
        assertThat(body.getValue())
                .contains("We decided X.")
                .contains("Settings");
    }

    private static UserEntity user(boolean autoEmail, String recapEmail, String accountEmail) {
        UserEntity u = new UserEntity();
        u.setId(USER);
        u.setEmail(accountEmail);
        u.setAutoEmailRecap(autoEmail);
        u.setRecapEmail(recapEmail);
        return u;
    }
}
