package com.recallix.security;

import com.recallix.entity.Meeting;
import com.recallix.repository.MeetingRepository;
import com.recallix.service.UserService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.MessageDeliveryException;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.MessageBuilder;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtException;

import java.security.Principal;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The second door.
 *
 * <p>{@code /ws/**} is {@code permitAll}, because the SockJS handshake carries
 * no credential and cannot. Everything that keeps somebody else's meeting out
 * of your socket happens one frame later, in the interceptor — so this file is
 * the whole of the evidence that it does.
 *
 * <p>What was possible before it: connect to the port, subscribe to
 * {@code /topic/meetings/{id}} for any id, and watch a stranger's meeting being
 * processed. Narrow — opaque ids, and the frames carry no transcript — but
 * "narrow" is not a security model, and it only held while there was one
 * account.
 *
 * <p>Every refusal below is asserted as a thrown {@link MessageDeliveryException},
 * which is what STOMP turns into an ERROR frame and a closed socket.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class StompAuthInterceptorTest {

    private static final String LOCAL_ID = "usr_owner";
    private static final String OTHER_ID = "usr_stranger";
    private static final String MEETING = "mtg_mine";

    @Mock private ClerkTokens tokens;
    @Mock private UserService users;
    @Mock private MeetingRepository meetings;

    private StompAuthInterceptor interceptor;
    private final MessageChannel channel = mock(MessageChannel.class);

    @BeforeEach
    void setUp() {
        interceptor = new StompAuthInterceptor(tokens, users, meetings);
        when(tokens.devMode()).thenReturn(false);
        when(users.provision(anyString(), any())).thenReturn(LOCAL_ID);
        // The owner owns exactly one meeting, and only under their own id.
        when(meetings.findByIdAndUserId(MEETING, LOCAL_ID))
                .thenReturn(Optional.of(new Meeting()));
        when(meetings.findByIdAndUserId(eq(MEETING), eq(OTHER_ID)))
                .thenReturn(Optional.empty());
    }

    /* ------------------------------ plumbing ------------------------------- */

    private void goodToken(String subject) {
        Jwt jwt = Jwt.withTokenValue("t")
                .header("alg", "RS256")
                .subject(subject)
                .claim("email", "owner@example.com")
                .issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(60))
                .build();
        when(tokens.verify("good")).thenReturn(jwt);
    }

    private Message<byte[]> frame(StompCommand command, Map<String, String> nativeHeaders,
                                  String destination, Principal user) {
        StompHeaderAccessor accessor = StompHeaderAccessor.create(command);
        nativeHeaders.forEach(accessor::setNativeHeader);
        if (destination != null) {
            accessor.setDestination(destination);
        }
        if (user != null) {
            accessor.setUser(user);
        }
        accessor.setLeaveMutable(true);
        return MessageBuilder.createMessage(new byte[0], accessor.getMessageHeaders());
    }

    private Principal connectWith(Map<String, String> headers) {
        Message<?> sent = interceptor.preSend(
                frame(StompCommand.CONNECT, headers, null, null), channel);
        StompHeaderAccessor out = StompHeaderAccessor.wrap(sent);
        return out.getUser();
    }

    private void subscribeAs(String userId, String destination) {
        Principal principal = userId == null
                ? null
                : new UsernamePasswordAuthenticationToken(userId, null);
        interceptor.preSend(frame(StompCommand.SUBSCRIBE, Map.of(), destination, principal), channel);
    }

    /* ------------------------------- CONNECT ------------------------------- */

    @Nested
    @DisplayName("establishing who is connecting")
    class Connecting {

        @Test
        @DisplayName("a valid token becomes the local account")
        void aValidTokenConnects() {
            goodToken("clerk_abc");

            Principal principal = connectWith(Map.of("Authorization", "Bearer good"));

            // The *local* id, not the Clerk subject: every topic in the system
            // is addressed by local user id, so a principal carrying the Clerk
            // one would fail every comparison below for the wrong reason.
            assertThat(principal).isNotNull();
            assertThat(principal.getName()).isEqualTo(LOCAL_ID);
            verify(users).provision("clerk_abc", "owner@example.com");
        }

        @Test
        @DisplayName("no credential is refused, not admitted as anonymous")
        void noCredentialIsRefused() {
            // Admitting it and relying on the subscription check would leave a
            // socket open for somebody who can never use it, and would make the
            // whole model depend on one branch further down.
            assertThatThrownBy(() -> connectWith(Map.of()))
                    .isInstanceOf(MessageDeliveryException.class);
            verify(users, never()).provision(anyString(), any());
        }

        @Test
        @DisplayName("an invalid token is refused")
        void aBadTokenIsRefused() {
            when(tokens.verify("forged")).thenThrow(new JwtException("bad signature"));

            assertThatThrownBy(() -> connectWith(Map.of("Authorization", "Bearer forged")))
                    .isInstanceOf(MessageDeliveryException.class);
        }

        @Test
        @DisplayName("a dev header is ignored when dev mode is off")
        void theDevHeaderIsNotACredential() {
            // The HTTP side fails closed the same way. A socket that still
            // honoured the header would be the bypass surviving in the one
            // place nobody thinks to check.
            assertThatThrownBy(() -> connectWith(Map.of("X-Dev-User", "usr_anyone")))
                    .isInstanceOf(MessageDeliveryException.class);
        }

        @Test
        @DisplayName("the refusal says nothing useful to whoever sent it")
        void theRefusalIsOpaque() {
            assertThatThrownBy(() -> connectWith(Map.of("Authorization", "Bearer ")))
                    .hasMessageContaining("Not authorised")
                    .hasMessageNotContaining("token")
                    .hasMessageNotContaining("expired");
        }

        @Test
        @DisplayName("dev mode still connects from the header when it is asked for")
        void devModeStillWorks() {
            // The reason dev mode exists: the stack runs with no Clerk account.
            when(tokens.devMode()).thenReturn(true);

            Principal principal = connectWith(Map.of("X-Dev-User", "usr_dev"));

            assertThat(principal).isNotNull();
            assertThat(principal.getName()).isEqualTo(LOCAL_ID);
        }
    }

    /* ------------------------------ SUBSCRIBE ------------------------------ */

    @Nested
    @DisplayName("deciding what a connection may listen to")
    class Subscribing {

        @Test
        @DisplayName("you may watch your own meeting")
        void yourOwnMeetingIsAllowed() {
            subscribeAs(LOCAL_ID, "/topic/meetings/" + MEETING);
        }

        @Test
        @DisplayName("you may not watch somebody else's")
        void anotherAccountsMeetingIsRefused() {
            // The bug this file exists for.
            assertThatThrownBy(() -> subscribeAs(OTHER_ID, "/topic/meetings/" + MEETING))
                    .isInstanceOf(MessageDeliveryException.class);
        }

        @Test
        @DisplayName("a meeting that does not exist is refused the same way")
        void anUnknownMeetingLooksIdentical() {
            // Two different answers here would make this a way to find out
            // which ids are real, one guess at a time.
            assertThatThrownBy(() -> subscribeAs(LOCAL_ID, "/topic/meetings/mtg_nope"))
                    .isInstanceOf(MessageDeliveryException.class)
                    .hasMessage("Not authorised");
        }

        @Test
        @DisplayName("you may listen to your own bell")
        void yourOwnNotificationsAreAllowed() {
            subscribeAs(LOCAL_ID, "/topic/users/" + LOCAL_ID + "/notifications");
        }

        @Test
        @DisplayName("you may not listen to somebody else's bell")
        void anotherAccountsNotificationsAreRefused() {
            assertThatThrownBy(() ->
                    subscribeAs(OTHER_ID, "/topic/users/" + LOCAL_ID + "/notifications"))
                    .isInstanceOf(MessageDeliveryException.class);
        }

        @Test
        @DisplayName("an unrecognised destination is refused")
        void defaultDeny() {
            // The property that matters most, because it is the one that keeps
            // holding for topics nobody has written yet. Every one of these is
            // a plausible thing somebody adds later without touching this file.
            for (String destination : new String[] {
                    "/topic",
                    "/topic/",
                    "/topic/everything",
                    "/topic/users/" + LOCAL_ID,
                    "/topic/meetings",
                    "/topic/meetings/" + MEETING + "/transcript",
                    "/queue/anything",
                    "/app/secret",
            }) {
                assertThatThrownBy(() -> subscribeAs(LOCAL_ID, destination))
                        .as("destination=%s", destination)
                        .isInstanceOf(MessageDeliveryException.class);
            }
        }

        @Test
        @DisplayName("a path that only looks like yours is refused")
        void noPrefixConfusion() {
            // `usr_owner` must not open `usr_owner2`, and a pattern anchored
            // loosely would let it.
            assertThatThrownBy(() ->
                    subscribeAs(LOCAL_ID, "/topic/users/" + LOCAL_ID + "2/notifications"))
                    .isInstanceOf(MessageDeliveryException.class);
        }

        @Test
        @DisplayName("a subscription with no connection behind it is refused")
        void noPrincipalIsRefused() {
            assertThatThrownBy(() -> subscribeAs(null, "/topic/meetings/" + MEETING))
                    .isInstanceOf(MessageDeliveryException.class);
        }

        @Test
        @DisplayName("a database that cannot answer is not permission")
        void anUnavailableDatabaseDenies() {
            when(meetings.findByIdAndUserId(anyString(), anyString()))
                    .thenThrow(new IllegalStateException("pool exhausted"));

            assertThatThrownBy(() -> subscribeAs(LOCAL_ID, "/topic/meetings/" + MEETING))
                    .isInstanceOf(MessageDeliveryException.class);
        }

        @Test
        @DisplayName("the tenant is not left behind on the broker thread")
        void theTenantIsCleared() {
            // These are pooled threads. A tenant left set would be inherited by
            // whoever the thread serves next, which is the one bug in this file
            // that would hand out somebody else's rows rather than refusing.
            TenantContext.clear();

            subscribeAs(LOCAL_ID, "/topic/meetings/" + MEETING);

            assertThat(TenantContext.currentUserId()).isEmpty();
        }
    }

    /* ------------------------------- passthrough ---------------------------- */

    @Test
    @DisplayName("frames that are neither are left alone")
    void otherCommandsPassThrough() {
        // SEND, ACK, DISCONNECT and the heartbeats. Nothing here is a decision,
        // and treating them as one would break the connection it just checked.
        Message<byte[]> disconnect = frame(StompCommand.DISCONNECT, Map.of(), null, null);

        assertThat(interceptor.preSend(disconnect, channel)).isNotNull();
    }
}
