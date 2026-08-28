package com.orion.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.orion.common.IdGenerator;
import com.orion.entity.OutboxEvent;
import com.orion.repository.OutboxEventRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Writes domain events into the transactional outbox so they commit atomically
 * with the business change (Outbox Pattern). A scheduled relay publishes them to
 * Kafka. Callers MUST invoke this inside their own transaction.
 */
@Service
public class OutboxService {

    private final OutboxEventRepository repo;
    private final ObjectMapper mapper;

    public OutboxService(OutboxEventRepository repo, ObjectMapper mapper) {
        this.repo = repo;
        this.mapper = mapper;
    }

    @Transactional
    public void enqueue(String topic, String partitionKey, Object payload) {
        OutboxEvent event = new OutboxEvent();
        event.setId(IdGenerator.outbox());
        event.setTopic(topic);
        event.setPartitionKey(partitionKey);
        event.setPayload(mapper.valueToTree(payload));
        event.setPublished(false);
        repo.save(event);
    }
}
