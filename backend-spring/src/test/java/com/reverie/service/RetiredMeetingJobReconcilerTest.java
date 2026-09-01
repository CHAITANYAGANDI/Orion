package com.reverie.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.reverie.dto.callback.StatusCallbackRequest;
import com.reverie.event.OutboxEventRetired;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

/**
 * A meeting whose job was thrown away must not sit in QUEUED forever.
 *
 * <p>The staleness rule that protects a newer attempt lives in
 * {@code CallbackService} and is tested there; what matters here is that this
 * class goes through it rather than around it. So these assert on what is handed
 * to {@code applyStatus} — the meeting, the attempt, a FAILED status — and the
 * companion test in {@code ProcessingAttemptRaceTest} proves what that path then
 * does with an old attempt.
 */
@ExtendWith(MockitoExtension.class)
class RetiredMeetingJobReconcilerTest {

    @Mock private CallbackService callbacks;

    private RetiredMeetingJobReconciler reconciler;
    private final ObjectMapper mapper = new ObjectMapper();

    @BeforeEach
    void setUp() {
        reconciler = new RetiredMeetingJobReconciler(callbacks);
    }

    private OutboxEventRetired retired(String topic, String meetingId, Integer attempt) {
        var payload = mapper.createObjectNode().put("meetingId", meetingId);
        if (attempt != null) {
            payload.put("processingAttempt", attempt);
        }
        return new OutboxEventRetired("obx_1", topic, meetingId, payload,
                "RecordTooLargeException: 2MB");
    }

    @Test
    @DisplayName("fails the meeting, for the run the dead event belonged to")
    void failsTheMeeting() {
        reconciler.onRetired(retired("meeting_uploaded", "mtg_a", 3));

        ArgumentCaptor<StatusCallbackRequest> sent =
                ArgumentCaptor.forClass(StatusCallbackRequest.class);
        verify(callbacks).applyStatus(eq("mtg_a"), sent.capture());

        // FAILED, carrying the attempt from the payload rather than whatever the
        // meeting happens to be on now — which is the entire reason a reprocess
        // is not collateral damage.
        org.assertj.core.api.Assertions.assertThat(sent.getValue().status()).isEqualTo("FAILED");
        org.assertj.core.api.Assertions.assertThat(sent.getValue().processingAttempt()).isEqualTo(3);
        org.assertj.core.api.Assertions.assertThat(sent.getValue().message())
                .contains("could not be started");
    }

    @Test
    @DisplayName("an event with no attempt in it can only ever fail the first run")
    void missingAttemptIsTreatedAsTheFirstRun() {
        reconciler.onRetired(retired("meeting_uploaded", "mtg_a", null));

        ArgumentCaptor<StatusCallbackRequest> sent =
                ArgumentCaptor.forClass(StatusCallbackRequest.class);
        verify(callbacks).applyStatus(eq("mtg_a"), sent.capture());
        // Null, which CallbackService reads as attempt 1 — the oldest run there
        // is, so a payload too broken to say which run it was for cannot reach
        // past the first one.
        org.assertj.core.api.Assertions.assertThat(sent.getValue().processingAttempt()).isNull();
    }

    @Test
    @DisplayName("leaves other topics alone")
    void ignoresOtherTopics() {
        reconciler.onRetired(retired("some_future_topic", "mtg_a", 1));

        verify(callbacks, never()).applyStatus(anyString(), any());
    }

    @Test
    @DisplayName("an event with no meeting id is reported, not guessed at")
    void ignoresAKeylessEvent() {
        reconciler.onRetired(new OutboxEventRetired(
                "obx_1", "meeting_uploaded", null, mapper.createObjectNode(), "boom"));

        verify(callbacks, never()).applyStatus(anyString(), any());
    }

    @Test
    @DisplayName("never takes the relay's batch down with it")
    void swallowsItsOwnFailure() {
        // This runs inside the publisher's transaction. Throwing would roll the
        // batch back, un-retire the event, and start the whole thing again next
        // tick — with this line nowhere in the log.
        doThrow(new IllegalStateException("database gone"))
                .when(callbacks).applyStatus(anyString(), any());

        assertThatCode(() -> reconciler.onRetired(retired("meeting_uploaded", "mtg_a", 1)))
                .doesNotThrowAnyException();
    }
}
