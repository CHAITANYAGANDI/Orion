package com.recallix.service;

import com.recallix.dto.StatusEvent;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Service;

/**
 * Fans a {@link StatusEvent} out to the frontend over STOMP
 * ({@code /topic/meetings/{id}}).
 *
 * <p>This used to also mirror the event into Redis under
 * {@code meeting:status:{id}} with a one-hour TTL, described as a polling
 * fallback. Nothing ever read it — the fallback is real, but it is
 * {@code GET /api/v1/meetings/{id}}, which reads Postgres, where the status was
 * already written by {@link CallbackService} in the same transaction that
 * recorded the result. The mirror was a network write per status change feeding
 * nothing, so it went with Redis itself.
 *
 * <p>Postgres remains the source of truth. A dropped STOMP frame costs latency
 * rather than correctness: the browser polls the meeting anyway, and reads the
 * committed row.
 */
@Service
public class StatusPublisher {

    private final SimpMessagingTemplate messaging;

    public StatusPublisher(SimpMessagingTemplate messaging) {
        this.messaging = messaging;
    }

    public void publish(StatusEvent event) {
        messaging.convertAndSend("/topic/meetings/" + event.meetingId(), event);
    }
}
