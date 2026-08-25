package com.recallix.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.recallix.entity.OutboxEvent;
import com.recallix.repository.OutboxEventRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.support.SendResult;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * What the relay does with the rows it has claimed.
 *
 * <p>The claiming itself is a database property and is proven against a real
 * PostgreSQL in {@code OutboxClaimConcurrencyTest} — a mock repository will
 * cheerfully hand two relays the same row, which is the bug, so a mock cannot
 * test the fix. What is worth pinning down here is the part above the database:
 * that the publisher asks for a claimed batch rather than a plain read, that a
 * row is marked only once Kafka has acknowledged it, and that a failure stops
 * the batch rather than stepping over the failed event.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class OutboxPublisherTest {

    @Mock private OutboxEventRepository repo;
    @Mock private KafkaTemplate<String, String> kafka;

    private OutboxPublisher publisher;
    private final ObjectMapper mapper = new ObjectMapper();

    @BeforeEach
    void setUp() {
        publisher = new OutboxPublisher(repo, kafka, mapper);
    }

    private OutboxEvent event(String id, String meetingId) {
        OutboxEvent e = new OutboxEvent();
        e.setId(id);
        e.setTopic("meeting_uploaded");
        e.setPartitionKey(meetingId);
        e.setPayload(mapper.createObjectNode().put("meetingId", meetingId));
        e.setPublished(false);
        e.setCreatedAt(Instant.parse("2026-08-25T09:00:00Z"));
        return e;
    }

    private void kafkaAccepts() {
        when(kafka.send(anyString(), anyString(), anyString()))
                .thenReturn(CompletableFuture.completedFuture((SendResult<String, String>) null));
    }

    private void kafkaRefuses(String forMeeting) {
        when(kafka.send(anyString(), anyString(), anyString()))
                .thenAnswer(i -> {
                    if (forMeeting.equals(i.getArgument(1))) {
                        return CompletableFuture.failedFuture(new IllegalStateException("broker down"));
                    }
                    return CompletableFuture.completedFuture(null);
                });
    }

    @Test
    @DisplayName("asks for a claimed batch, not a plain read of what is pending")
    void claimsRatherThanReads() {
        when(repo.claimBatch(anyInt())).thenReturn(List.of());

        publisher.publishBatch();

        // The whole of Phase 2 in one assertion: the old call took no locks, so
        // two instances read the same rows and both published them.
        verify(repo).claimBatch(anyInt());
    }

    @Test
    @DisplayName("marks a row published once Kafka has acknowledged it")
    void marksAfterTheAcknowledgement() {
        OutboxEvent only = event("obx_1", "mtg_a");
        when(repo.claimBatch(anyInt())).thenReturn(List.of(only));
        kafkaAccepts();

        publisher.publishBatch();

        assertThat(only.isPublished()).isTrue();
        verify(kafka).send(eq("meeting_uploaded"), eq("mtg_a"), anyString());
    }

    @Test
    @DisplayName("leaves a row unpublished when the send fails")
    void aFailedSendIsNotMarked() {
        OutboxEvent only = event("obx_1", "mtg_a");
        when(repo.claimBatch(anyInt())).thenReturn(List.of(only));
        kafkaRefuses("mtg_a");

        publisher.publishBatch();

        // Nothing to retry from, no counter, no dead-letter — the row is simply
        // still pending, and the lock on it goes when this transaction ends.
        assertThat(only.isPublished()).isFalse();
    }

    @Test
    @DisplayName("stops the batch at the first failure rather than stepping over it")
    void aFailureStopsTheBatch() {
        OutboxEvent first = event("obx_1", "mtg_a");
        OutboxEvent second = event("obx_2", "mtg_b");
        OutboxEvent third = event("obx_3", "mtg_c");
        when(repo.claimBatch(anyInt())).thenReturn(List.of(first, second, third));
        kafkaRefuses("mtg_b");

        publisher.publishBatch();

        assertThat(first.isPublished()).isTrue();
        assertThat(second.isPublished()).isFalse();
        // Not attempted at all. Skipping past a broker that just refused a
        // message to try ninety-nine more is a way to turn one failure into a
        // hundred, and the row is not going anywhere.
        assertThat(third.isPublished()).isFalse();
        verify(kafka, never()).send(anyString(), eq("mtg_c"), anyString());
    }

    @Test
    @DisplayName("the rows that did land stay landed")
    void earlierSuccessesSurviveALaterFailure() {
        // They are genuinely in Kafka. Rolling them back to unpublished would
        // guarantee a duplicate rather than risk one.
        OutboxEvent first = event("obx_1", "mtg_a");
        OutboxEvent second = event("obx_2", "mtg_b");
        when(repo.claimBatch(anyInt())).thenReturn(List.of(first, second));
        kafkaRefuses("mtg_b");

        publisher.publishBatch();

        assertThat(first.isPublished()).isTrue();
    }

    @Test
    @DisplayName("publishes the payload as the JSON it was stored as")
    void sendsTheStoredJson() {
        OutboxEvent only = event("obx_1", "mtg_a");
        when(repo.claimBatch(anyInt())).thenReturn(List.of(only));
        List<String> sent = new ArrayList<>();
        when(kafka.send(anyString(), anyString(), anyString())).thenAnswer(i -> {
            sent.add(i.getArgument(2));
            return CompletableFuture.completedFuture(null);
        });

        publisher.publishBatch();

        assertThat(sent).containsExactly("{\"meetingId\":\"mtg_a\"}");
    }

    @Test
    @DisplayName("an empty outbox sends nothing")
    void nothingPendingIsNotAnError() {
        when(repo.claimBatch(anyInt())).thenReturn(List.of());

        publisher.publishBatch();

        verify(kafka, never()).send(anyString(), anyString(), anyString());
    }
}
