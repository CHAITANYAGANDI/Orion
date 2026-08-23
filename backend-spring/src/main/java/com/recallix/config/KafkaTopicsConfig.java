package com.recallix.config;

import org.apache.kafka.clients.admin.NewTopic;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.TopicBuilder;

/**
 * Declares the Kafka topics from api-contracts §6 so they are created on
 * startup (KafkaAdmin is non-fatal if the broker is briefly unavailable).
 */
@Configuration
public class KafkaTopicsConfig {

    public static final String MEETING_UPLOADED = "meeting_uploaded";
    public static final String TRANSCRIPTION_STARTED = "transcription_started";
    public static final String TRANSCRIPTION_COMPLETED = "transcription_completed";
    public static final String SUMMARY_GENERATED = "summary_generated";
    public static final String ACTION_ITEMS_EXTRACTED = "action_items_extracted";
    public static final String MEETING_PROCESSING_FAILED = "meeting_processing_failed";
    public static final String USAGE_LIMIT_REACHED = "usage_limit_reached";

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
    @Bean NewTopic transcriptionStartedTopic() { return topic(TRANSCRIPTION_STARTED); }
    @Bean NewTopic transcriptionCompletedTopic() { return topic(TRANSCRIPTION_COMPLETED); }
    @Bean NewTopic summaryGeneratedTopic() { return topic(SUMMARY_GENERATED); }
    @Bean NewTopic actionItemsExtractedTopic() { return topic(ACTION_ITEMS_EXTRACTED); }
    @Bean NewTopic meetingProcessingFailedTopic() { return topic(MEETING_PROCESSING_FAILED); }
    @Bean NewTopic usageLimitReachedTopic() { return topic(USAGE_LIMIT_REACHED); }
}
