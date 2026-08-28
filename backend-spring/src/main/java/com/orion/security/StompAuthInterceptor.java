package com.orion.security;

import com.orion.repository.MeetingRepository;
import com.orion.service.UserService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.MessageDeliveryException;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.messaging.support.MessageHeaderAccessor;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Component;

import java.security.Principal;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The lock on the second door.
 *
 * <h2>What was open</h2>
 *
 * <p>{@code /ws/**} is {@code permitAll} in {@code SecurityConfig}, because the
 * SockJS handshake is a plain HTTP GET that carries no credential — a browser
 * cannot set headers on it. That is normal and fine. What was missing is the
 * check that has to happen afterwards: nothing authenticated the STOMP
 * {@code CONNECT} frame, and nothing checked who was subscribing to what. Any
 * client that could reach the port could subscribe to
 * {@code /topic/meetings/{id}} for any id and watch somebody else's meeting
 * being processed.
 *
 * <p>The blast radius was narrow — ids are opaque, the frames carry
 * {@code {status, progress, message}} and no transcript, and the notification
 * frame deliberately carries an unread <em>count</em> and nothing else (see
 * {@code NotificationPublisher}) — but "narrow" is not a security model, and it
 * only held because there was one account. With real users it is somebody
 * else's data.
 *
 * <h2>Two checks, not one</h2>
 *
 * <p><b>CONNECT</b> establishes who this connection is, from the same token the
 * API uses, verified by the same {@link ClerkTokens}. No identity, no
 * connection: the frame is refused rather than allowed through as anonymous,
 * because an anonymous connection that can subscribe to nothing is a socket
 * held open for no reason and a subscription bug waiting to matter.
 *
 * <p><b>SUBSCRIBE</b> authorises the destination against that identity, and it
 * is <b>default deny</b>. Two shapes are allowed and everything else is
 * refused, so a topic added later is private until somebody writes it down
 * here. Getting that the other way round is a mistake you make once and never
 * notice.
 *
 * <h2>Why the broker cannot do this for us</h2>
 *
 * <p>{@code enableSimpleBroker("/topic")} fans out to every subscriber of a
 * destination. Spring's {@code /user/**} destinations would scope by principal
 * for free, but the topics are public by name and the publishers address them
 * by meeting id — so the check has to happen where a subscription is accepted,
 * which is here.
 */
@Component
public class StompAuthInterceptor implements ChannelInterceptor {

    private static final Logger log = LoggerFactory.getLogger(StompAuthInterceptor.class);

    /** `/topic/meetings/{meetingId}` — see StatusPublisher. */
    private static final Pattern MEETING_TOPIC =
            Pattern.compile("^/topic/meetings/([^/]+)$");

    /** `/topic/users/{userId}/notifications` — see NotificationPublisher. */
    private static final Pattern NOTIFICATION_TOPIC =
            Pattern.compile("^/topic/users/([^/]+)/notifications$");

    private final ClerkTokens tokens;
    private final UserService users;
    private final MeetingRepository meetings;

    public StompAuthInterceptor(ClerkTokens tokens, UserService users, MeetingRepository meetings) {
        this.tokens = tokens;
        this.users = users;
        this.meetings = meetings;
    }

    @Override
    public Message<?> preSend(Message<?> message, MessageChannel channel) {
        StompHeaderAccessor accessor =
                MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);
        if (accessor == null || accessor.getCommand() == null) {
            return message;
        }
        if (accessor.getCommand() == StompCommand.CONNECT) {
            accessor.setUser(authenticate(accessor));
        } else if (accessor.getCommand() == StompCommand.SUBSCRIBE) {
            authorize(accessor);
        }
        return message;
    }

    /**
     * Who is on the other end of this connection.
     *
     * @throws MessageDeliveryException when nobody is, which STOMP turns into
     *     an ERROR frame and a closed socket
     */
    private Principal authenticate(StompHeaderAccessor accessor) {
        String subject = subjectOf(accessor);
        if (subject == null || subject.isBlank()) {
            throw refuse("CONNECT without a valid credential");
        }
        // Provisioning runs before the local user id exists, so it cannot
        // satisfy a tenant policy yet — the same bootstrap the HTTP filter does.
        String localUserId;
        try {
            localUserId = TenantContext.asSystem(() -> users.provision(subject, emailOf(accessor)));
        } catch (Exception e) {
            throw refuse("could not resolve the account behind that credential");
        }
        if (localUserId == null || localUserId.isBlank()) {
            throw refuse("no account behind that credential");
        }
        return new UsernamePasswordAuthenticationToken(
                localUserId, null, List.of(new SimpleGrantedAuthority("ROLE_USER")));
    }

    /**
     * The Clerk subject, or the dev header when dev mode is explicitly on.
     *
     * <p>Returns null for anything it cannot verify. A malformed or expired
     * token is not an error to report to the client — the answer is the same as
     * for no token at all, and saying which is a small oracle.
     */
    private String subjectOf(StompHeaderAccessor accessor) {
        if (tokens.devMode()) {
            return first(accessor, "X-Dev-User");
        }
        String header = first(accessor, "Authorization");
        if (header == null || !header.startsWith("Bearer ")) {
            return null;
        }
        try {
            return tokens.verify(header.substring(7)).getSubject();
        } catch (RuntimeException e) {
            log.debug("STOMP CONNECT rejected: {}", e.getMessage());
            return null;
        }
    }

    private String emailOf(StompHeaderAccessor accessor) {
        if (tokens.devMode()) {
            return first(accessor, "X-Dev-Email");
        }
        String header = first(accessor, "Authorization");
        if (header == null || !header.startsWith("Bearer ")) {
            return null;
        }
        try {
            Jwt jwt = tokens.verify(header.substring(7));
            for (String claim : List.of("email", "email_address", "primary_email_address")) {
                if (jwt.getClaim(claim) instanceof String s && !s.isBlank()) {
                    return s.trim();
                }
            }
        } catch (RuntimeException e) {
            /* already refused above; nothing to add */
        }
        return null;
    }

    /**
     * Whether this connection may listen to this destination.
     *
     * <p>Default deny. Anything not matched below is refused, including
     * anything under {@code /topic} that does not exist yet.
     */
    private void authorize(StompHeaderAccessor accessor) {
        Principal principal = accessor.getUser();
        if (principal == null) {
            // Unreachable while CONNECT is enforced above, and checked anyway:
            // this is the assumption that would silently stop holding if the
            // CONNECT branch were ever relaxed.
            throw refuse("SUBSCRIBE before CONNECT");
        }
        String userId = principal.getName();
        String destination = accessor.getDestination();
        if (destination == null) {
            throw refuse("SUBSCRIBE with no destination");
        }

        Matcher notifications = NOTIFICATION_TOPIC.matcher(destination);
        if (notifications.matches()) {
            // The channel *is* the local user id — see NotificationCountResponse.
            if (!userId.equals(notifications.group(1))) {
                throw refuse("subscription to another account's notifications");
            }
            return;
        }

        Matcher meeting = MEETING_TOPIC.matcher(destination);
        if (meeting.matches()) {
            if (!owns(userId, meeting.group(1))) {
                // Deliberately the same refusal as a meeting that does not
                // exist. Distinguishing them would turn this into a way to test
                // whether an id is real.
                throw refuse("subscription to a meeting that is not yours");
            }
            return;
        }

        throw refuse("subscription to an unrecognised destination");
    }

    /**
     * Does this account own that meeting?
     *
     * <p>Asked twice over, and cheaply. The tenant is set so row-level security
     * scopes the read exactly as it would on any request — this thread is not a
     * request thread, so nothing else would have set it — and the query names
     * the owner as well, so the answer does not rest on the policy alone.
     *
     * <p>Cleared in a finally: these are pooled broker threads, and a tenant
     * left behind on one would be inherited by whoever it serves next.
     */
    private boolean owns(String userId, String meetingId) {
        String previous = TenantContext.currentUserId();
        try {
            TenantContext.setUserId(userId);
            return meetings.findByIdAndUserId(meetingId, userId).isPresent();
        } catch (RuntimeException e) {
            // A database that cannot answer is not permission to listen.
            log.warn("Could not check meeting ownership for a subscription: {}", e.toString());
            return false;
        } finally {
            TenantContext.setUserId(previous);
        }
    }

    private static String first(StompHeaderAccessor accessor, String name) {
        List<String> values = accessor.getNativeHeader(name);
        if (values == null || values.isEmpty()) {
            return null;
        }
        String value = values.get(0);
        return value == null || value.isBlank() ? null : value.trim();
    }

    private static MessageDeliveryException refuse(String why) {
        log.debug("STOMP refused: {}", why);
        // The message reaches the client in the ERROR frame, so it says what
        // was refused and never why it might have been allowed.
        return new MessageDeliveryException("Not authorised");
    }
}
