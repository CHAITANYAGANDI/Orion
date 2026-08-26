package com.recallix.dto.callback;

import com.recallix.domain.MeetingStatus;

/**
 * What the worker is told when it asks whether a job is still worth doing.
 *
 * <p>Read before a redelivered {@code meeting_uploaded} is processed, and it
 * exists because delivery is honestly at-least-once. A redelivery used to cost
 * a second full transcription of the same recording — the provider bills per
 * run — even when the first run had already finished and written its result
 * down. One meeting in testing was transcribed three times for one upload.
 *
 * <p>Two fields, because two different things make a run pointless:
 * <ul>
 *   <li>{@code status} terminal — READY or FAILED — means this run reached the
 *       end and Spring has it. Nothing is left to compute.</li>
 *   <li>{@code processingAttempt} ahead of the run in the message means a
 *       reprocess has replaced it, and its own {@code meeting_uploaded} is in
 *       the topic. Finishing this one would produce a result
 *       {@code CallbackService.applyResult} is going to refuse anyway.</li>
 * </ul>
 *
 * <p>A meeting that is <em>not</em> here at all is reported by a 404 rather
 * than by a row of nulls: Stop deletes the meeting, and a worker that keeps
 * transcribing something the user cancelled is spending money on nothing.
 *
 * <p>Deliberately says nothing about the transcript, the summary or the audio.
 * This is a scheduling question, and the answer travels over the internal
 * callback channel to a process that has no user context.
 */
public record MeetingJobState(MeetingStatus status, int processingAttempt) {

    /**
     * Whether this run has finished, one way or the other.
     *
     * <p>FAILED counts. A run that failed has already reported itself and
     * raised the bell notification; redelivering it would either fail the same
     * way at the same cost or, worse, succeed and quietly overwrite an error a
     * person has already been shown and may have acted on.
     */
    public boolean terminal() {
        return status == MeetingStatus.READY || status == MeetingStatus.FAILED;
    }
}
