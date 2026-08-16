package com.recallix.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Service;

import java.util.Map;

/**
 * Tells a connected browser that its bell has changed, and nothing else.
 *
 * <p><strong>Why the frame carries no content.</strong> The STOMP endpoint is
 * unauthenticated — it is a public SockJS endpoint and a subscription is just a
 * topic name — so anything put on a topic is readable by anyone who can guess
 * the topic. Meeting status can live with that: a status and a percentage say
 * almost nothing. A notification cannot: its whole value is that it contains the
 * meeting's title and the task's wording.
 *
 * <p>So the frame is a bare count. The browser hears "something changed" and
 * re-reads the list over the authenticated REST API, where the row is checked
 * against the caller the same way every other read is. A stranger guessing a
 * user id learns that a notification happened and nothing about what it was —
 * and the client keeps a slow poll anyway, so a dropped frame costs latency
 * rather than correctness.
 */
@Service
public class NotificationPublisher {

    private static final Logger log = LoggerFactory.getLogger(NotificationPublisher.class);

    private final SimpMessagingTemplate messaging;

    public NotificationPublisher(SimpMessagingTemplate messaging) {
        this.messaging = messaging;
    }

    public void ping(String userId, long unread) {
        try {
            messaging.convertAndSend("/topic/users/" + userId + "/notifications",
                    Map.of("unread", unread));
        } catch (Exception e) {
            // A browser that is not listening is the normal case, and a broker
            // that is unhappy must not fail the thing being notified about.
            log.debug("Notification ping failed for {}: {}", userId, e.getMessage());
        }
    }
}
