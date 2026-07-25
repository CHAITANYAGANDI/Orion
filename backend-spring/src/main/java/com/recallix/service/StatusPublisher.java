package com.recallix.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.recallix.dto.StatusEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Service;

import java.time.Duration;

/**
 * Fans a {@link StatusEvent} out to the frontend over STOMP
 * ({@code /topic/meetings/{id}}) and mirrors the latest status into Redis
 * ({@code meeting:status:{id}}, TTL 1h) for a polling fallback (api-contracts §7).
 */
@Service
public class StatusPublisher {

    private static final Logger log = LoggerFactory.getLogger(StatusPublisher.class);
    private static final Duration TTL = Duration.ofHours(1);

    private final SimpMessagingTemplate messaging;
    private final StringRedisTemplate redis;
    private final ObjectMapper mapper;

    public StatusPublisher(SimpMessagingTemplate messaging,
                           StringRedisTemplate redis,
                           ObjectMapper mapper) {
        this.messaging = messaging;
        this.redis = redis;
        this.mapper = mapper;
    }

    public void publish(StatusEvent event) {
        messaging.convertAndSend("/topic/meetings/" + event.meetingId(), event);
        try {
            redis.opsForValue().set(
                    "meeting:status:" + event.meetingId(),
                    mapper.writeValueAsString(event),
                    TTL);
        } catch (Exception e) {
            log.debug("Redis status mirror failed for {}: {}", event.meetingId(), e.getMessage());
        }
    }
}
