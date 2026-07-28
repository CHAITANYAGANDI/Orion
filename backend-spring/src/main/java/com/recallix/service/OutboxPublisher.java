package com.recallix.service;

import com.recallix.entity.OutboxEvent;
import com.recallix.repository.OutboxEventRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.PageRequest;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * The transactional half of the outbox relay.
 *
 * <p>Separate from {@link OutboxRelay} for the same reason the memory listener
 * is separate from its service: the tenant has to be established *before* the
 * transaction opens, because the connection is borrowed — and stamped — at that
 * moment. Setting it inside a {@code @Transactional} method would be too late,
 * and the outbox would silently read zero rows under row-level security.
 */
@Component
public class OutboxPublisher {

    private static final Logger log = LoggerFactory.getLogger(OutboxPublisher.class);
    private static final int BATCH = 100;

    private final OutboxEventRepository repo;
    private final KafkaTemplate<String, String> kafka;
    private final com.fasterxml.jackson.databind.ObjectMapper mapper;

    public OutboxPublisher(OutboxEventRepository repo,
                           KafkaTemplate<String, String> kafka,
                           com.fasterxml.jackson.databind.ObjectMapper mapper) {
        this.repo = repo;
        this.kafka = kafka;
        this.mapper = mapper;
    }

    @Transactional
    public void publishBatch() {
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
