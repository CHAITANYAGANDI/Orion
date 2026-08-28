package com.orion.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import org.apache.kafka.common.errors.InvalidTopicException;
import org.apache.kafka.common.errors.RecordTooLargeException;
import org.apache.kafka.common.errors.SerializationException;

import java.util.List;

/**
 * Why publishing an outbox event failed: because of the event, or because of
 * everything.
 *
 * <p>This is the decision that makes the difference between a poison event
 * being retired and an afternoon of Confluent being down deleting a day of
 * meetings, so it is worth being precise about how it is made.
 *
 * <h2>Why not simply trust {@code RetriableException}</h2>
 *
 * <p>Kafka's client library already sorts its exceptions into retriable and
 * not, and the obvious implementation is "not retriable, therefore dead". That
 * is wrong here, and dangerously so. {@code RetriableException} means <em>the
 * producer may usefully retry this send by itself, right now</em> — a much
 * narrower question than <em>will this ever work</em>. Checked against the
 * classes in kafka-clients 3.7.1, these are all {@code retriable = false}:
 *
 * <pre>
 *   SaslAuthenticationException          expired or rotated API key
 *   SslAuthenticationException           certificate problem
 *   TopicAuthorizationException          ACL not granted yet
 *   ClusterAuthorizationException        ditto, cluster-wide
 *   UnsupportedVersionException          broker older than the client expects
 *   InvalidRequiredAcksException         producer misconfigured
 * </pre>
 *
 * <p>Every one is an operational problem that a person fixes in minutes and
 * that says nothing whatever about the event. A rule of "not retriable → dead"
 * would, on the day an API key expires, mark <em>every unpublished meeting in
 * the backlog</em> permanently failed — silently converting a credential
 * rotation into lost work. Nothing in the system would ever retry them again.
 *
 * <h2>So the test is inverted</h2>
 *
 * <p>Nothing is permanent unless it is recognised as permanent. The list is
 * short, closed, and every entry is a condition where the failure is a property
 * of the row itself and no amount of waiting changes it:
 *
 * <pre>
 *   RecordTooLargeException   this payload exceeds what the broker accepts.
 *                             The payload does not get smaller.
 *   SerializationException    the record cannot be turned into bytes.
 *   InvalidTopicException     the topic name is not a legal topic name, and
 *                             the topic is a column on this row.
 *   JsonProcessingException   the stored payload will not render as JSON.
 *                             Thrown before Kafka is involved at all.
 * </pre>
 *
 * <p>Everything else — timeouts, disconnects, unknown topics, authentication,
 * authorization, an unrecognised {@code RuntimeException}, a bug — is
 * {@link #INFRASTRUCTURE}: retried with backoff, indefinitely, and never
 * discarded. The asymmetry is deliberate. Retrying something hopeless costs one
 * row and some log lines; discarding something valid costs a meeting the user
 * paid for and cannot get back.
 *
 * <p>Two classes that look like they belong on the list and are deliberately
 * absent. {@code RecordBatchTooLargeException} is about the producer's batch,
 * which may hold records other than this one, so a retry can legitimately
 * succeed. {@code UnsupportedForMessageFormatException} is about the broker's
 * message format, which is a broker setting rather than anything to do with
 * this event.
 *
 * <h2>Unwrapping</h2>
 *
 * <p>The interesting exception is never the one thrown. {@code send(...).get()}
 * throws {@code ExecutionException}, and spring-kafka has already wrapped the
 * producer's exception in {@code KafkaProducerException} beneath it — verified
 * against spring-kafka 3.2.4, which does
 * {@code completeExceptionally(new KafkaProducerException(record, "Failed to send", cause))}.
 * So the real cause sits two levels down:
 *
 * <pre>
 *   ExecutionException
 *     └── KafkaProducerException: Failed to send
 *           └── RecordTooLargeException: The message is 2000000 bytes ...
 * </pre>
 *
 * <p>Rather than assume a fixed depth, the whole chain is walked and every link
 * tested. A synchronous throw from {@code send()} itself — a closed producer,
 * say — arrives with no wrapper at all and is handled by the same walk.
 */
public enum OutboxFailure {

    /** A property of this row. Retrying cannot help; the event is retired. */
    EVENT_PERMANENT,

    /** Everything else. Retried with backoff, indefinitely, never discarded. */
    INFRASTRUCTURE;

    /**
     * The closed set of conditions that are the event's own fault.
     *
     * <p>Matched with {@code isInstance}, so subclasses count — every
     * {@code JsonProcessingException} subtype (parse, mapping, generation) is a
     * problem with the stored payload just as its parent is.
     */
    private static final List<Class<? extends Throwable>> PERMANENT = List.of(
            RecordTooLargeException.class,
            SerializationException.class,
            InvalidTopicException.class,
            JsonProcessingException.class);

    /** Depth limit, because a cause chain is allowed to be a cycle. */
    private static final int MAX_DEPTH = 12;

    /**
     * Classify a failure by examining it and everything that caused it.
     *
     * <p>Unrecognised means {@link #INFRASTRUCTURE}. That is the entire safety
     * property: a failure mode nobody anticipated keeps the event alive.
     */
    public static OutboxFailure of(Throwable thrown) {
        Throwable t = thrown;
        for (int depth = 0; t != null && depth < MAX_DEPTH; depth++) {
            for (Class<? extends Throwable> permanent : PERMANENT) {
                if (permanent.isInstance(t)) {
                    return EVENT_PERMANENT;
                }
            }
            Throwable next = t.getCause();
            t = next == t ? null : next;
        }
        return INFRASTRUCTURE;
    }

    /**
     * A short description of what actually went wrong, for {@code last_error}
     * and the log.
     *
     * <p>The deepest cause, because the outer two links are always
     * {@code ExecutionException} and "Failed to send" and neither has ever told
     * anybody anything. Type name included: several Kafka exceptions carry no
     * message at all, and {@code "null"} in an error column is worse than
     * useless.
     *
     * <p>Built from the type and message only, never from the exception itself.
     * {@code KafkaProducerException} holds the whole {@code ProducerRecord},
     * payload included, and this string is written to a database column and a
     * log line.
     */
    public static String describe(Throwable thrown) {
        Throwable deepest = thrown;
        for (int i = 0; i < MAX_DEPTH; i++) {
            Throwable next = deepest.getCause();
            if (next == null || next == deepest) {
                break;
            }
            deepest = next;
        }
        String message = deepest.getMessage();
        String described = deepest.getClass().getSimpleName()
                + (message == null || message.isBlank() ? "" : ": " + message);
        return described.length() <= 500 ? described : described.substring(0, 500);
    }
}
