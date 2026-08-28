package com.orion.config;

import org.apache.kafka.clients.admin.NewTopic;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.TopicBuilder;

/**
 * Declares the Kafka topic used to dispatch work to the AI service, so it is
 * created on startup (KafkaAdmin is non-fatal if the broker is briefly
 * unavailable).
 *
 * <p>There were eight. Seven carried stage and billing events that only
 * {@code KafkaStatusConsumer} subscribed to, and all it did with them was write
 * a log line — the transcript, the summary and the FAILED state all arrive over
 * the internal HTTP callback and are persisted by {@link
 * com.orion.service.CallbackService}, so the topics duplicated nothing and
 * drove nothing. Two of them, {@code payment_successful} and
 * {@code usage_limit_reached}, had no producer at all once Stripe was removed
 * in V49.
 *
 * <p>{@code meeting_uploaded} stays, because it is the one that does work:
 * enqueued through the transactional outbox and consumed by the worker that
 * runs the pipeline.
 */
@Configuration
public class KafkaTopicsConfig {

    public static final String MEETING_UPLOADED = "meeting_uploaded";

    /**
     * One partition, broker-default replication.
     *
     * <p>{@code replicas(-1)} means "whatever the broker defaults to" rather than
     * a literal factor, and the difference matters on a managed broker: Confluent
     * Cloud enforces a replication factor of 3 and rejects an explicit 1 with
     * POLICY_VIOLATION, so hardcoding 1 would fail every topic creation there
     * while working locally. KafkaAdmin only logs that failure, so the first
     * symptom would be uploads that never reach the worker.
     */
    private NewTopic topic(String name) {
        return TopicBuilder.name(name).partitions(1).replicas(-1).build();
    }

    @Bean NewTopic meetingUploadedTopic() { return topic(MEETING_UPLOADED); }
}
