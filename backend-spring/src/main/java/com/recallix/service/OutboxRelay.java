package com.recallix.service;

import com.recallix.entity.OutboxEvent;
import com.recallix.repository.OutboxEventRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.PageRequest;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * Polls the outbox and relays unpublished events to Kafka (at-least-once). Runs
 * frequently; a single instance is fine for this scale. If Kafka is down the
 * rows simply stay unpublished and are retried on the next tick.
 */
@Component
public class OutboxRelay {

    private static final Logger log = LoggerFactory.getLogger(OutboxRelay.class);
    private static final int BATCH = 100;

    private final OutboxEventRepository repo;
    private final KafkaTemplate<String, String> kafka;
    private final com.fasterxml.jackson.databind.ObjectMapper mapper;

    public OutboxRelay(OutboxEventRepository repo,
                       KafkaTemplate<String, String> kafka,
                       com.fasterxml.jackson.databind.ObjectMapper mapper) {
        this.repo = repo;
        this.kafka = kafka;
        this.mapper = mapper;
    }

    @Scheduled(fixedDelayString = "${recallix.outbox.poll-ms:1000}")
    @Transactional
    public void publishPending() {
        List<OutboxEvent> pending = repo.findByPublishedFalseOrderByCreatedAtAsc(PageRequest.of(0, BATCH));
        for (OutboxEvent event : pending) {
            try {
                String payload = mapper.writeValueAsString(event.getPayload());
                kafka.send(event.getTopic(), event.getPartitionKey(), payload).get();
                event.setPublished(true);
            } catch (Exception e) {
                // Leave unpublished; retried next tick. Stop the batch to preserve order.
                log.warn("Outbox publish failed for {} ({}): {}", event.getId(), event.getTopic(), e.getMessage());
                break;
            }
        }
    }
}
