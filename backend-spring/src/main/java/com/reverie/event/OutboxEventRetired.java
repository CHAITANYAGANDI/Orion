package com.reverie.event;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Published when the relay gives up on an outbox event for good.
 *
 * <p>This exists so the outbox can stay generic. The relay knows how to publish
 * rows and how to tell a bad payload from a bad afternoon; it does not know what
 * any particular topic <em>means</em>, and teaching it would make every future
 * topic somebody's business logic inside the publisher. What it can honestly say
 * is that a specific event will never be delivered — and leave the consequences
 * to whoever owns that topic.
 *
 * <p>Handled <strong>synchronously, inside the relay's transaction</strong>, and
 * that is deliberate: the retirement and whatever it implies commit together or
 * not at all. A listener that ran after commit could fail on its own and leave
 * the event retired with nothing done about it, which is the exact shape of the
 * problem this event was added to fix.
 *
 * <p>A listener must therefore be short and must not throw. Throwing takes the
 * whole batch down with it, and since the classification that produced the
 * retirement is deterministic, the next tick would arrive at the same place.
 *
 * @param id           the outbox row, which is still there to be looked at
 * @param topic        what the event was for
 * @param partitionKey the ordering key — the meeting id, for
 *                     {@code meeting_uploaded}
 * @param payload      the event body as it was stored
 * @param lastError    why it was given up on, already trimmed and free of payload
 */
public record OutboxEventRetired(
        String id,
        String topic,
        String partitionKey,
        JsonNode payload,
        String lastError) {
}
