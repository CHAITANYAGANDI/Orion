package com.orion.service;

import com.fasterxml.jackson.core.JsonParseException;
import com.fasterxml.jackson.databind.JsonMappingException;
import org.apache.kafka.common.errors.AuthenticationException;
import org.apache.kafka.common.errors.ClusterAuthorizationException;
import org.apache.kafka.common.errors.DisconnectException;
import org.apache.kafka.common.errors.InvalidTopicException;
import org.apache.kafka.common.errors.NetworkException;
import org.apache.kafka.common.errors.NotEnoughReplicasException;
import org.apache.kafka.common.errors.RecordBatchTooLargeException;
import org.apache.kafka.common.errors.RecordTooLargeException;
import org.apache.kafka.common.errors.SaslAuthenticationException;
import org.apache.kafka.common.errors.SerializationException;
import org.apache.kafka.common.errors.SslAuthenticationException;
import org.apache.kafka.common.errors.TimeoutException;
import org.apache.kafka.common.errors.TopicAuthorizationException;
import org.apache.kafka.common.errors.UnknownTopicOrPartitionException;
import org.apache.kafka.common.errors.UnsupportedForMessageFormatException;
import org.apache.kafka.common.errors.UnsupportedVersionException;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.kafka.core.KafkaProducerException;

import java.util.concurrent.ExecutionException;

import static com.orion.service.OutboxFailure.EVENT_PERMANENT;
import static com.orion.service.OutboxFailure.INFRASTRUCTURE;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * Which failures retire an event and which ones wait.
 *
 * <p>Real exception types throughout, not {@code RuntimeException} stand-ins,
 * because the whole question is about a specific taxonomy and a test that only
 * knows about {@code RuntimeException} would agree with any implementation at
 * all — including the dangerous one this class exists to rule out.
 */
class OutboxFailureTest {

    /** What {@code send(...).get()} actually throws: two wrappers deep. */
    private static Throwable asThrownByGet(Throwable cause) {
        ProducerRecord<String, String> record =
                new ProducerRecord<>("meeting_uploaded", "mtg_a", "{}");
        return new ExecutionException(
                new KafkaProducerException(record, "Failed to send", cause));
    }

    @Nested
    @DisplayName("the event's own fault")
    class Permanent {

        @Test
        @DisplayName("a payload the broker will never accept")
        void recordTooLarge() {
            assertThat(OutboxFailure.of(asThrownByGet(
                    new RecordTooLargeException("The message is 2000000 bytes"))))
                    .isEqualTo(EVENT_PERMANENT);
        }

        @Test
        @DisplayName("a record that cannot be turned into bytes")
        void serialization() {
            assertThat(OutboxFailure.of(asThrownByGet(new SerializationException("nope"))))
                    .isEqualTo(EVENT_PERMANENT);
        }

        @Test
        @DisplayName("a topic name that is not a legal topic name")
        void invalidTopic() {
            assertThat(OutboxFailure.of(asThrownByGet(new InvalidTopicException("bad/name"))))
                    .isEqualTo(EVENT_PERMANENT);
        }

        @Test
        @DisplayName("a stored payload that will not render as JSON")
        void jsonProcessing() {
            // Thrown by the mapper, before Kafka is involved, so it arrives bare.
            assertThat(OutboxFailure.of(new JsonParseException(
                    (com.fasterxml.jackson.core.JsonParser) null, "unexpected token")))
                    .isEqualTo(EVENT_PERMANENT);
        }

        @Test
        @DisplayName("and its subclasses count too")
        void jsonSubclasses() {
            assertThat(OutboxFailure.of(JsonMappingException.from((com.fasterxml.jackson.core.JsonParser) null, "no")))
                    .isEqualTo(EVENT_PERMANENT);
        }
    }

    @Nested
    @DisplayName("everything else waits")
    class Transient {

        @Test
        @DisplayName("the ordinary outage shapes")
        void outages() {
            assertThat(OutboxFailure.of(asThrownByGet(new TimeoutException("no leader"))))
                    .isEqualTo(INFRASTRUCTURE);
            assertThat(OutboxFailure.of(asThrownByGet(new NetworkException("connection reset"))))
                    .isEqualTo(INFRASTRUCTURE);
            assertThat(OutboxFailure.of(asThrownByGet(new DisconnectException("gone"))))
                    .isEqualTo(INFRASTRUCTURE);
            assertThat(OutboxFailure.of(asThrownByGet(new NotEnoughReplicasException("1 < 2"))))
                    .isEqualTo(INFRASTRUCTURE);
        }

        @Test
        @DisplayName("an unknown topic is a topic that has not been created YET")
        void unknownTopic() {
            // Tempting to call permanent, and wrong: a fresh cluster, a broker
            // still propagating metadata and a genuinely missing topic all
            // produce this, and the first two fix themselves.
            assertThat(OutboxFailure.of(asThrownByGet(
                    new UnknownTopicOrPartitionException("meeting_uploaded"))))
                    .isEqualTo(INFRASTRUCTURE);
        }

        @Test
        @DisplayName("an expired API key does not discard the backlog")
        void credentials() {
            // The reason this class does not use Kafka's own retriable flag.
            // Every one of these is retriable=false, and every one of them is
            // somebody's afternoon rather than a bad event. Under a
            // "not retriable, therefore dead" rule, a credential rotation would
            // terminally discard every unpublished meeting in the queue.
            assertThat(OutboxFailure.of(asThrownByGet(new SaslAuthenticationException("expired"))))
                    .isEqualTo(INFRASTRUCTURE);
            assertThat(OutboxFailure.of(asThrownByGet(new SslAuthenticationException("bad cert"))))
                    .isEqualTo(INFRASTRUCTURE);
            assertThat(OutboxFailure.of(asThrownByGet(new AuthenticationException("who?"))))
                    .isEqualTo(INFRASTRUCTURE);
            assertThat(OutboxFailure.of(asThrownByGet(new TopicAuthorizationException("no ACL"))))
                    .isEqualTo(INFRASTRUCTURE);
            assertThat(OutboxFailure.of(asThrownByGet(new ClusterAuthorizationException("no"))))
                    .isEqualTo(INFRASTRUCTURE);
        }

        @Test
        @DisplayName("a broker or client version mismatch is an upgrade, not a bad event")
        void versions() {
            assertThat(OutboxFailure.of(asThrownByGet(new UnsupportedVersionException("old broker"))))
                    .isEqualTo(INFRASTRUCTURE);
            assertThat(OutboxFailure.of(asThrownByGet(
                    new UnsupportedForMessageFormatException("v0 message format"))))
                    .isEqualTo(INFRASTRUCTURE);
        }

        @Test
        @DisplayName("a batch being too large is about the batch, not this record")
        void batchTooLarge() {
            // Deliberately not permanent, though it reads like RecordTooLarge:
            // the producer's batch can hold other records, so a retry that
            // batches differently can succeed.
            assertThat(OutboxFailure.of(asThrownByGet(new RecordBatchTooLargeException("too big"))))
                    .isEqualTo(INFRASTRUCTURE);
        }

        @Test
        @DisplayName("a failure nobody anticipated keeps the event alive")
        void unrecognised() {
            assertThat(OutboxFailure.of(asThrownByGet(new IllegalStateException("producer closed"))))
                    .isEqualTo(INFRASTRUCTURE);
            assertThat(OutboxFailure.of(new NullPointerException())).isEqualTo(INFRASTRUCTURE);
            assertThat(OutboxFailure.of(new InterruptedException("shutting down")))
                    .isEqualTo(INFRASTRUCTURE);
        }
    }

    @Nested
    @DisplayName("finding the cause at all")
    class Unwrapping {

        @Test
        @DisplayName("looks past both wrappers, not just the first")
        void twoDeep() {
            // If this only unwrapped ExecutionException it would see
            // KafkaProducerException, recognise nothing, and call a poison event
            // transient — which is a meeting blocked forever.
            Throwable thrown = asThrownByGet(new RecordTooLargeException("2MB"));
            assertThat(thrown.getCause()).isInstanceOf(KafkaProducerException.class);
            assertThat(OutboxFailure.of(thrown)).isEqualTo(EVENT_PERMANENT);
        }

        @Test
        @DisplayName("an unwrapped throw is classified just the same")
        void bare() {
            assertThat(OutboxFailure.of(new RecordTooLargeException("2MB")))
                    .isEqualTo(EVENT_PERMANENT);
        }

        @Test
        @DisplayName("a self-referencing cause does not hang")
        void cycle() {
            Throwable loop = new IllegalStateException("round we go") {
                @Override
                public synchronized Throwable getCause() {
                    return this;
                }
            };
            assertThat(OutboxFailure.of(loop)).isEqualTo(INFRASTRUCTURE);
            assertThat(OutboxFailure.describe(loop)).contains("round we go");
        }
    }

    @Nested
    @DisplayName("what gets written down")
    class Describe {

        @Test
        @DisplayName("the deepest cause, typed")
        void deepest() {
            String described = OutboxFailure.describe(
                    asThrownByGet(new TimeoutException("Topic meeting_uploaded not present")));

            assertThat(described)
                    .isEqualTo("TimeoutException: Topic meeting_uploaded not present");
        }

        @Test
        @DisplayName("never the payload, which the wrapper is carrying")
        void noPayload() {
            // KafkaProducerException holds the whole ProducerRecord. This string
            // goes into a database column and a log line, so it is built from
            // the type and message and nothing else.
            ProducerRecord<String, String> record = new ProducerRecord<>(
                    "meeting_uploaded", "mtg_a", "{\"secret\":\"do not log me\"}");
            Throwable thrown = new ExecutionException(new KafkaProducerException(
                    record, "Failed to send", new TimeoutException("timed out")));

            assertThat(OutboxFailure.describe(thrown)).doesNotContain("do not log me");
        }

        @Test
        @DisplayName("a message-less exception still says something")
        void noMessage() {
            assertThat(OutboxFailure.describe(asThrownByGet(new NetworkException())))
                    .isEqualTo("NetworkException");
        }

        @Test
        @DisplayName("bounded, because it goes in a column")
        void bounded() {
            assertThat(OutboxFailure.describe(new TimeoutException("x".repeat(5000))))
                    .hasSizeLessThanOrEqualTo(500);
        }
    }
}
