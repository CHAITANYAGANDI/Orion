package com.reverie.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.reverie.entity.OutboxEvent;
import com.reverie.repository.OutboxEventRepository;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.springframework.context.ApplicationEventPublisher;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.errors.RecordTooLargeException;
import org.apache.kafka.common.errors.SaslAuthenticationException;
import org.apache.kafka.common.errors.TimeoutException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.kafka.core.KafkaProducerException;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.support.SendResult;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
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
 * row is marked only once Kafka has acknowledged it, and — the Phase 3
 * addition — what it writes down when a send fails, which depends entirely on
 * why it failed.
 *
 * <p>The clock is fixed, so the retry schedule is an exact assertion rather than
 * a range. Nothing here sleeps.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class OutboxPublisherTest {

    private static final Instant NOW = Instant.parse("2026-08-25T12:00:00Z");

    @Mock private OutboxEventRepository repo;
    @Mock private KafkaTemplate<String, String> kafka;

    private OutboxPublisher publisher;
    private MeterRegistry metrics;
    /** Retirements land here so a test can see what the relay announced. */
    private List<Object> announced;
    private final ObjectMapper mapper = new ObjectMapper();

    @BeforeEach
    void setUp() {
        metrics = new SimpleMeterRegistry();
        announced = new ArrayList<>();
        publisher = new OutboxPublisher(repo, kafka, mapper, metrics,
                (ApplicationEventPublisher) announced::add, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private OutboxEvent event(String id, String meetingId) {
        OutboxEvent e = new OutboxEvent();
        e.setId(id);
        e.setTopic("meeting_uploaded");
        e.setPartitionKey(meetingId);
        e.setPayload(mapper.createObjectNode().put("meetingId", meetingId));
        e.setPublished(false);
        e.setCreatedAt(Instant.parse("2026-08-25T09:00:00Z"));
        e.setNextAttemptAt(Instant.parse("2026-08-25T09:00:00Z"));
        return e;
    }

    private void kafkaAccepts() {
        when(kafka.send(anyString(), anyString(), anyString()))
                .thenReturn(CompletableFuture.completedFuture((SendResult<String, String>) null));
    }

    /** Fails only for the named meeting, exactly as the producer would report it. */
    private void kafkaRefuses(String forMeeting, Throwable cause) {
        when(kafka.send(anyString(), anyString(), anyString())).thenAnswer(i -> {
            if (forMeeting.equals(i.getArgument(1))) {
                ProducerRecord<String, String> record = new ProducerRecord<>(
                        i.getArgument(0), i.getArgument(1), i.getArgument(2));
                return CompletableFuture.failedFuture(
                        new KafkaProducerException(record, "Failed to send", cause));
            }
            return CompletableFuture.completedFuture(null);
        });
    }

    private double counter(String name, String... tags) {
        return metrics.find(name).tags(tags).counter() == null
                ? 0d
                : metrics.find(name).tags(tags).counter().count();
    }

    // --- the parts that did not change ------------------------------------- //

    @Test
    @DisplayName("asks for a claimed batch, not a plain read of what is pending")
    void claimsRatherThanReads() {
        when(repo.claimBatch(anyInt())).thenReturn(List.of());

        publisher.publishBatch();

        // Phase 2 in one assertion: the old call took no locks, so two instances
        // read the same rows and both published them.
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
        assertThat(only.getFailedAt()).isNull();
        assertThat(only.getAttemptCount()).isZero();
        verify(kafka).send(eq("meeting_uploaded"), eq("mtg_a"), anyString());
        assertThat(counter("reverie.outbox.published")).isEqualTo(1d);
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

    // --- a failure that says something about the broker --------------------- //

    @Nested
    @DisplayName("an infrastructure failure")
    class Infrastructure {

        @Test
        @DisplayName("leaves the row pending, and writes down when to try again")
        void recordsRetryMetadata() {
            OutboxEvent only = event("obx_1", "mtg_a");
            when(repo.claimBatch(anyInt())).thenReturn(List.of(only));
            kafkaRefuses("mtg_a", new TimeoutException("no leader for partition"));

            publisher.publishBatch();

            assertThat(only.isPublished()).isFalse();
            assertThat(only.isTerminal()).isFalse();
            assertThat(only.getAttemptCount()).isEqualTo(1);
            assertThat(only.getNextAttemptAt()).isEqualTo(NOW.plusSeconds(5));
            assertThat(only.getLastError())
                    .isEqualTo("TimeoutException: no leader for partition");
            assertThat(counter("reverie.outbox.failures", "category", "infrastructure"))
                    .isEqualTo(1d);
            assertThat(counter("reverie.outbox.retired")).isZero();
        }

        @Test
        @DisplayName("backs off further each time it fails")
        void backsOff() {
            // The schedule is durable, so the count it reads is the one the last
            // tick committed — this is what a row on its fourth failure looks
            // like when it is claimed again.
            OutboxEvent onItsFourth = event("obx_1", "mtg_a");
            onItsFourth.setAttemptCount(3);
            when(repo.claimBatch(anyInt())).thenReturn(List.of(onItsFourth));
            kafkaRefuses("mtg_a", new TimeoutException("still down"));

            publisher.publishBatch();

            assertThat(onItsFourth.getAttemptCount()).isEqualTo(4);
            assertThat(onItsFourth.getNextAttemptAt()).isEqualTo(NOW.plusSeconds(40));
        }

        @Test
        @DisplayName("but never backs off past the cap")
        void capped() {
            OutboxEvent stuckForDays = event("obx_1", "mtg_a");
            stuckForDays.setAttemptCount(400);
            when(repo.claimBatch(anyInt())).thenReturn(List.of(stuckForDays));
            kafkaRefuses("mtg_a", new TimeoutException("still down"));

            publisher.publishBatch();

            // Not a negative delay from an overflowed shift, and not a week.
            assertThat(stuckForDays.getNextAttemptAt()).isEqualTo(NOW.plus(Duration.ofMinutes(5)));
        }

        @Test
        @DisplayName("stops the batch rather than waiting out the timeout a hundred times")
        void stopsTheBatch() {
            OutboxEvent first = event("obx_1", "mtg_a");
            OutboxEvent second = event("obx_2", "mtg_b");
            OutboxEvent third = event("obx_3", "mtg_c");
            when(repo.claimBatch(anyInt())).thenReturn(List.of(first, second, third));
            kafkaRefuses("mtg_b", new TimeoutException("broker down"));

            publisher.publishBatch();

            assertThat(first.isPublished()).isTrue();
            assertThat(second.isPublished()).isFalse();
            assertThat(third.isPublished()).isFalse();
            verify(kafka, never()).send(anyString(), eq("mtg_c"), anyString());

            // And meeting C is not penalised for it: nothing was written to its
            // row, so it is still due, and the next tick — one second later —
            // claims it without the failed row, which is now backing off.
            assertThat(third.getAttemptCount()).isZero();
            assertThat(third.getNextAttemptAt()).isEqualTo(Instant.parse("2026-08-25T09:00:00Z"));
        }

        @Test
        @DisplayName("the rows that did land stay landed")
        void earlierSuccessesSurviveALaterFailure() {
            // They are genuinely in Kafka. Rolling them back to unpublished
            // would guarantee a duplicate rather than risk one.
            OutboxEvent first = event("obx_1", "mtg_a");
            OutboxEvent second = event("obx_2", "mtg_b");
            when(repo.claimBatch(anyInt())).thenReturn(List.of(first, second));
            kafkaRefuses("mtg_b", new TimeoutException("broker down"));

            publisher.publishBatch();

            assertThat(first.isPublished()).isTrue();
        }

        @Test
        @DisplayName("an expired credential is an outage, not a hundred bad events")
        void credentialsDoNotDiscardWork() {
            // The failure mode this whole phase is arranged to avoid: on the day
            // an API key expires, every event in the backlog must still be there
            // afterwards.
            List<OutboxEvent> backlog = List.of(
                    event("obx_1", "mtg_a"), event("obx_2", "mtg_b"), event("obx_3", "mtg_c"));
            when(repo.claimBatch(anyInt())).thenReturn(backlog);
            when(kafka.send(anyString(), anyString(), anyString())).thenAnswer(i ->
                    CompletableFuture.failedFuture(new KafkaProducerException(
                            new ProducerRecord<>("meeting_uploaded", "k", "{}"),
                            "Failed to send",
                            new SaslAuthenticationException("Authentication failed: credentials expired"))));

            for (int tick = 0; tick < 50; tick++) {
                publisher.publishBatch();
            }

            assertThat(backlog).allSatisfy(e -> {
                assertThat(e.isTerminal()).isFalse();
                assertThat(e.isPublished()).isFalse();
            });
            assertThat(counter("reverie.outbox.retired")).isZero();
        }
    }

    // --- a failure that says something about the event ---------------------- //

    @Nested
    @DisplayName("an event that can never be published")
    class Poison {

        @Test
        @DisplayName("is retired on the first attempt, and kept")
        void retired() {
            OutboxEvent tooBig = event("obx_1", "mtg_a");
            when(repo.claimBatch(anyInt())).thenReturn(List.of(tooBig));
            kafkaRefuses("mtg_a", new RecordTooLargeException("The message is 2000000 bytes"));

            publisher.publishBatch();

            assertThat(tooBig.isTerminal()).isTrue();
            assertThat(tooBig.getFailedAt()).isEqualTo(NOW);
            assertThat(tooBig.isPublished()).isFalse();
            assertThat(tooBig.getAttemptCount()).isEqualTo(1);
            // Everything needed to work out what happened, still on the row.
            assertThat(tooBig.getLastError()).contains("RecordTooLargeException");
            assertThat(tooBig.getPayload()).isNotNull();
            assertThat(counter("reverie.outbox.retired")).isEqualTo(1d);
            assertThat(counter("reverie.outbox.failures", "category", "event_permanent"))
                    .isEqualTo(1d);
        }

        @Test
        @DisplayName("does not stop the unrelated meetings claimed alongside it")
        void doesNotStopTheBatch() {
            // Safe precisely because of the claim query: at most one row per key
            // is ever eligible, so meetings B and C cannot be the retired event's
            // successors — they are different meetings, and A's own next event
            // was never in this batch to overtake anything.
            OutboxEvent poison = event("obx_1", "mtg_a");
            OutboxEvent second = event("obx_2", "mtg_b");
            OutboxEvent third = event("obx_3", "mtg_c");
            when(repo.claimBatch(anyInt())).thenReturn(List.of(poison, second, third));
            kafkaRefuses("mtg_a", new RecordTooLargeException("2MB"));

            publisher.publishBatch();

            assertThat(poison.isTerminal()).isTrue();
            assertThat(second.isPublished()).isTrue();
            assertThat(third.isPublished()).isTrue();
            assertThat(counter("reverie.outbox.published")).isEqualTo(2d);
        }

        @Test
        @DisplayName("a payload that will not render never reaches Kafka at all")
        void unrenderablePayload() {
            OutboxEvent broken = event("obx_1", "mtg_a");
            OutboxEvent fine = event("obx_2", "mtg_b");
            ObjectMapper refuses = new ObjectMapper() {
                @Override
                public String writeValueAsString(Object value)
                        throws com.fasterxml.jackson.core.JsonProcessingException {
                    if (String.valueOf(value).contains("mtg_a")) {
                        throw new com.fasterxml.jackson.core.JsonParseException(
                                (com.fasterxml.jackson.core.JsonParser) null, "unrenderable");
                    }
                    return super.writeValueAsString(value);
                }
            };
            OutboxPublisher withBrokenMapper = new OutboxPublisher(
                    repo, kafka, refuses, metrics,
                    (ApplicationEventPublisher) announced::add, Clock.fixed(NOW, ZoneOffset.UTC));
            when(repo.claimBatch(anyInt())).thenReturn(List.of(broken, fine));
            kafkaAccepts();

            withBrokenMapper.publishBatch();

            assertThat(broken.isTerminal()).isTrue();
            verify(kafka, never()).send(anyString(), eq("mtg_a"), anyString());
            assertThat(fine.isPublished()).isTrue();
        }
    }

    // --- the schedule itself ------------------------------------------------ //

    @Nested
    @DisplayName("the backoff")
    class Backoff {

        @Test
        @DisplayName("doubles from five seconds and stops at five minutes")
        void schedule() {
            assertThat(OutboxPublisher.retryDelay(1)).isEqualTo(Duration.ofSeconds(5));
            assertThat(OutboxPublisher.retryDelay(2)).isEqualTo(Duration.ofSeconds(10));
            assertThat(OutboxPublisher.retryDelay(3)).isEqualTo(Duration.ofSeconds(20));
            assertThat(OutboxPublisher.retryDelay(4)).isEqualTo(Duration.ofSeconds(40));
            assertThat(OutboxPublisher.retryDelay(5)).isEqualTo(Duration.ofSeconds(80));
            assertThat(OutboxPublisher.retryDelay(6)).isEqualTo(Duration.ofSeconds(160));
            assertThat(OutboxPublisher.retryDelay(7)).isEqualTo(Duration.ofMinutes(5));
            assertThat(OutboxPublisher.retryDelay(8)).isEqualTo(Duration.ofMinutes(5));
        }

        @Test
        @DisplayName("stays positive however long something has been stuck")
        void neverOverflows() {
            for (int attempt : new int[]{31, 32, 33, 64, 1000, Integer.MAX_VALUE}) {
                assertThat(OutboxPublisher.retryDelay(attempt))
                        .as("attempt %d", attempt)
                        .isEqualTo(Duration.ofMinutes(5));
            }
        }

        @Test
        @DisplayName("is the same function on every instance, with no jitter to disagree about")
        void deterministic() {
            assertThat(OutboxPublisher.retryDelay(3)).isEqualTo(OutboxPublisher.retryDelay(3));
        }
    }
}
