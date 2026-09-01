package com.reverie.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.reverie.config.KafkaTopicsConfig;
import com.reverie.dto.callback.StatusCallbackRequest;
import com.reverie.event.OutboxEventRetired;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * What happens to a meeting whose job was never posted.
 *
 * <p>Phase 3 gave the relay the ability to give up on an event that can never be
 * published, which stopped one impossible message blocking a meeting's queue
 * forever. It left a hole directly behind it. The event the relay gives up on is
 * usually the only one a meeting has:
 *
 * <pre>
 *   reprocess          → status QUEUED, attempt N, meeting_uploaded enqueued
 *   publication fails  → permanently, so the row is retired
 *   the worker         → never hears about it
 *   the meeting        → QUEUED. Forever. Nothing is coming.
 * </pre>
 *
 * <p>Nothing else in the system would ever notice. There is no timeout on
 * QUEUED, no sweeper looking for meetings that stopped moving, and no failure
 * anywhere to report — every component did exactly what it was told. The user
 * watches a spinner for a job that does not exist.
 *
 * <h2>Why this is a listener rather than code in the publisher</h2>
 *
 * <p>The relay should not know what a meeting is. It publishes rows and
 * classifies failures; the moment it starts calling into the meeting domain,
 * every future topic's business logic ends up inside it. So it announces a fact
 * — this event will never be delivered — and this class, which does know what
 * {@code meeting_uploaded} means, decides the consequence. That boundary already
 * exists in the codebase: {@code CallbackService} publishes
 * {@code MeetingReadyEvent} the same way.
 *
 * <h2>Why it goes through the callback path</h2>
 *
 * <p>Failing a meeting is not one field. It is the status, the error message,
 * the bell notification, the WebSocket frame that takes the spinner off an open
 * page — and, most importantly, the attempt check that decides whether this
 * failure is even relevant any more. {@link CallbackService#applyStatus} already
 * does all five, correctly, and is the same path the worker's own FAILED status
 * takes. Writing a second version here would be a second set of failure
 * semantics to keep in step with the first.
 *
 * <p>That check is what handles the case the phase brief singles out: a retired
 * event from an <em>older</em> attempt. If the user reprocessed after the
 * failure, the meeting has moved on to a newer run, and
 * {@code applyStatus} recognises the old attempt as stale and does nothing. The
 * dead event does not drag the live run down with it. This class does not
 * implement that rule; it just does not bypass it.
 */
@Component
public class RetiredMeetingJobReconciler {

    private static final Logger log = LoggerFactory.getLogger(RetiredMeetingJobReconciler.class);

    /**
     * What the user is told. Deliberately about the job rather than the outbox:
     * "publication failed" describes our plumbing, not their meeting.
     */
    private static final String MESSAGE =
            "Processing could not be started for this recording. Please try again.";

    private final CallbackService callbacks;

    public RetiredMeetingJobReconciler(CallbackService callbacks) {
        this.callbacks = callbacks;
    }

    @EventListener
    public void onRetired(OutboxEventRetired retired) {
        if (!KafkaTopicsConfig.MEETING_UPLOADED.equals(retired.topic())) {
            // Some other topic's problem. There are none today; when there are,
            // they get their own listener rather than a branch in this one.
            return;
        }
        String meetingId = retired.partitionKey();
        if (meetingId == null || meetingId.isBlank()) {
            log.error("Retired {} event {} has no meeting id; cannot reconcile it.",
                    retired.topic(), retired.id());
            return;
        }
        try {
            // Null attempt is read by CallbackService as the first run, which is
            // the oldest there is — so an event too malformed to say which run
            // it belongs to can only ever fail a meeting still on attempt 1, and
            // never a reprocess.
            callbacks.applyStatus(meetingId, new StatusCallbackRequest(
                    "FAILED", 100, MESSAGE, attemptIn(retired.payload())));
            log.error("Meeting {} failed because its job could not be published "
                            + "(outbox event {} retired: {}).",
                    meetingId, retired.id(), retired.lastError());
        } catch (RuntimeException e) {
            // Never take the relay's batch down. The row stays retired and the
            // meeting stays where it is, which is bad, but rolling back would
            // un-retire the event and start the loop again — worse, and it would
            // hide this line.
            log.error("Could not fail meeting {} after retiring outbox event {}: {}",
                    meetingId, retired.id(), e.toString());
        }
    }

    /** The run this job was for, or null if the payload will not say. */
    private static Integer attemptIn(JsonNode payload) {
        if (payload == null) {
            return null;
        }
        JsonNode attempt = payload.get("processingAttempt");
        return attempt == null || !attempt.isInt() ? null : attempt.intValue();
    }
}
