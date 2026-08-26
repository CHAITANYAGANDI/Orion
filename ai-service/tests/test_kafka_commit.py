"""When the worker is allowed to acknowledge a message, and when it is not.

The failure this replaces was silent. With `enable_auto_commit=True` the offset
advanced about five seconds after the message was handed to the loop, so a
worker that died during a twelve-minute transcription came back with the job
already acknowledged and never ran it again — the meeting sat in QUEUED with no
error, no retry and nothing in the bell.

Every test here is about the boundary that replaced it: an offset is committed
only once Spring has written down a terminal outcome, or has said in as many
words that it never will.

Nothing sleeps for a real backoff; the worker takes its own timings so the
tests can set them to zero.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import httpx
import pytest

from app.callback import Delivery, JobState
from app.kafka_worker import KafkaWorker, Outcome, is_retryable
from app.providers.assemblyai_adapter import (
    AudioUnreachableError,
    TranscriptionConfigurationError,
)
from app.schemas import MeetingUploadedEvent


EVENT = MeetingUploadedEvent(
    meetingId="mtg_1",
    userId="usr_1",
    objectKey="meetings/usr_1/mtg_1/audio.m4a",
)


class RecordingCallback:
    """A Spring that says yes, unless told otherwise."""

    def __init__(
        self,
        *,
        result: Delivery = Delivery.ACCEPTED,
        status: Delivery = Delivery.ACCEPTED,
        state: "JobState | None" = None,
    ) -> None:
        self.result_delivery = result
        self.status_delivery = status
        self.statuses: list[str] = []
        self.attempts: list[int | None] = []
        self.results = 0
        # What Spring says when asked whether the job is still worth running.
        # The default is a meeting mid-flight on run 1, which is every test
        # below that is not about the skip itself.
        self.state = state if state is not None else JobState(status="QUEUED", attempt=1)
        self.state_reads = 0

    async def job_state(self, meeting_id) -> "JobState | None":
        self.state_reads += 1
        return self.state

    async def post_result(self, meeting_id, result, *, attempt=None) -> Delivery:
        self.results += 1
        self.attempts.append(attempt)
        return self.result_delivery

    async def post_status(self, meeting_id, event, *, attempt=None) -> Delivery:
        self.statuses.append(event.status)
        self.attempts.append(attempt)
        return self.status_delivery


def worker(callback, *, max_attempts: int = 5) -> KafkaWorker:
    return KafkaWorker(
        settings=SimpleNamespace(
            kafka_bootstrap_servers="localhost:9092",
            kafka_topic_meeting_uploaded="meeting_uploaded",
            kafka_consumer_group="ai-service",
            kafka_security_protocol="PLAINTEXT",
            kafka_max_poll_interval_ms=6_000_000,
            kafka_session_timeout_ms=45_000,
            kafka_heartbeat_interval_ms=10_000,
        ),
        pipeline=None,
        callback=callback,
        rag=None,
        max_attempts=max_attempts,
        retry_backoff_seconds=0.0,
    )


def drive(w: KafkaWorker, process, *, failures: int = 0, event=EVENT) -> Outcome:
    """Run one message through `_handle` with the pipeline stubbed out."""
    w._process_source = process  # noqa: SLF001 — the seam under test is around it
    return asyncio.run(w._handle(event, failures=failures))  # noqa: SLF001


async def _succeeds(event, progress_hook, transcript_hook):
    return SimpleNamespace(transcript="hello", segments=[])


# --------------------------------------------------------------------------- #
# Success
# --------------------------------------------------------------------------- #
def test_success_commits_only_after_the_result_is_accepted():
    cb = RecordingCallback()

    assert drive(worker(cb), _succeeds) is Outcome.COMMIT
    assert cb.results == 1
    assert "READY" in cb.statuses


def test_a_rejected_result_callback_is_not_committed():
    # Everything was computed and none of it is written down anywhere. This is
    # exactly the case auto-commit acknowledged.
    cb = RecordingCallback(result=Delivery.UNDELIVERED)

    assert drive(worker(cb), _succeeds) is Outcome.RETRY
    assert "READY" not in cb.statuses


def test_a_lost_ready_frame_does_not_hold_the_offset():
    # applyResult has already persisted the brief and flipped the meeting to
    # READY, so the terminal state exists. Redelivering the whole meeting to
    # re-send one WebSocket frame would re-run a paid transcription.
    cb = RecordingCallback(status=Delivery.UNDELIVERED)

    assert drive(worker(cb), _succeeds) is Outcome.COMMIT


def test_handle_starting_is_not_an_acknowledgement():
    # The old behaviour in one assertion: beginning work must not be enough.
    started = asyncio.Event()

    async def never_finishes(event, progress_hook, transcript_hook):
        started.set()
        raise httpx.ConnectError("provider unreachable")

    cb = RecordingCallback()
    assert drive(worker(cb), never_finishes) is Outcome.RETRY
    assert started.is_set()
    assert cb.results == 0


# --------------------------------------------------------------------------- #
# Failure
# --------------------------------------------------------------------------- #
def test_a_retryable_failure_is_left_uncommitted():
    async def transient(event, progress_hook, transcript_hook):
        raise httpx.ConnectError("connection reset")

    cb = RecordingCallback()
    assert drive(worker(cb), transient) is Outcome.RETRY
    # Nothing was reported as failed: the meeting is still going to be retried,
    # and telling the user it failed would be wrong.
    assert "FAILED" not in cb.statuses


def test_a_terminal_failure_commits_once_failed_is_accepted():
    async def refused(event, progress_hook, transcript_hook):
        raise TranscriptionConfigurationError("that parameter is not valid")

    cb = RecordingCallback()
    assert drive(worker(cb), refused) is Outcome.COMMIT
    assert cb.statuses[-1] == "FAILED"


def test_a_terminal_failure_nobody_heard_is_not_committed():
    # The failure is real and unrecorded. Acknowledging here loses it the same
    # way auto-commit did.
    async def refused(event, progress_hook, transcript_hook):
        raise TranscriptionConfigurationError("that parameter is not valid")

    cb = RecordingCallback(status=Delivery.UNDELIVERED)
    assert drive(worker(cb), refused) is Outcome.RETRY


def test_audio_that_could_not_be_fetched_is_terminal():
    # It only escapes the adapter once the byte-upload fallback has been tried,
    # so there is no second path left.
    async def unreachable(event, progress_hook, transcript_hook):
        raise AudioUnreachableError("could not connect to the host")

    cb = RecordingCallback()
    assert drive(worker(cb), unreachable) is Outcome.COMMIT
    assert cb.statuses[-1] == "FAILED"


def test_retries_are_bounded_so_one_message_cannot_block_the_partition():
    # meeting_uploaded has a single partition. A message that is never
    # committed is not just stuck itself -- every later meeting queues behind
    # it, so "retry forever" is an outage.
    async def transient(event, progress_hook, transcript_hook):
        raise httpx.ConnectError("connection reset")

    cb = RecordingCallback()
    w = worker(cb, max_attempts=3)

    assert drive(w, transient, failures=0) is Outcome.RETRY
    assert drive(w, transient, failures=1) is Outcome.RETRY
    # The third failure gives up and records it, rather than holding the queue.
    assert drive(w, transient, failures=2) is Outcome.COMMIT
    assert cb.statuses[-1] == "FAILED"


# --------------------------------------------------------------------------- #
# Refusal — Spring read it and said no, and will say no again
# --------------------------------------------------------------------------- #
def test_a_refused_result_is_finished_rather_than_retried():
    # The obsolete-run case. Spring declined the result because a reprocess has
    # overtaken it, so there is no version of this message that can succeed and
    # holding the single partition open for it is an outage with no upside.
    cb = RecordingCallback(result=Delivery.REFUSED)

    assert drive(worker(cb), _succeeds) is Outcome.COMMIT
    # And it does not go on to announce a meeting it was refused.
    assert "READY" not in cb.statuses


def test_a_refused_failure_report_is_also_finished():
    async def broken(event, progress_hook, transcript_hook):
        raise TranscriptionConfigurationError("that parameter is not valid")

    cb = RecordingCallback(status=Delivery.REFUSED)
    assert drive(worker(cb), broken) is Outcome.COMMIT


# --------------------------------------------------------------------------- #
# Classification
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("code", [408, 425, 429, 500, 502, 503, 504])
def test_transient_http_statuses_are_retryable(code):
    exc = httpx.HTTPStatusError(
        "x", request=httpx.Request("POST", "http://x"), response=httpx.Response(code)
    )
    assert is_retryable(exc) is True


@pytest.mark.parametrize("code", [400, 401, 403, 404, 422])
def test_a_request_that_was_wrong_is_not_retryable(code):
    exc = httpx.HTTPStatusError(
        "x", request=httpx.Request("POST", "http://x"), response=httpx.Response(code)
    )
    assert is_retryable(exc) is False


@pytest.mark.parametrize(
    "exc",
    [
        httpx.ConnectError("x"),
        httpx.ReadTimeout("x"),
        asyncio.TimeoutError(),
        ConnectionResetError(),
        OSError("broken pipe"),
    ],
)
def test_infrastructure_failures_are_retryable(exc):
    assert is_retryable(exc) is True


def test_an_unrecognised_failure_is_retryable_by_default():
    # A blip is far more likely than a permanently poisoned recording, and the
    # attempt bound is what stops the default being dangerous.
    assert is_retryable(ValueError("something odd")) is True


def test_a_refused_request_is_never_retried():
    assert is_retryable(TranscriptionConfigurationError("bad parameter")) is False


# --------------------------------------------------------------------------- #
# A redelivery must not cost a second transcription
#
# Delivery is at-least-once by design, and the provider bills per run. Before
# this guard a redelivered job was re-transcribed in full: one 42-minute upload
# was submitted to AssemblyAI three times (07:25, 07:29, 07:39) because the
# consumer kept being evicted mid-run, and the meeting's status walked backwards
# from EXTRACTING to TRANSCRIBING while somebody watched it.
#
# `_handle` now asks Spring what state the meeting is in before it spends
# anything. `_never_runs` is the assertion that carries these: if the pipeline
# is entered at all, the money is already gone.
# --------------------------------------------------------------------------- #
async def _never_runs(event, progress_hook, transcript_hook):
    raise AssertionError("the pipeline ran for a job that was already settled")


@pytest.mark.parametrize("status", ["READY", "FAILED"])
def test_a_redelivery_of_a_finished_run_is_skipped_not_re_transcribed(status):
    cb = RecordingCallback(state=JobState(status=status, attempt=1))

    assert drive(worker(cb), _never_runs) is Outcome.COMMIT
    assert cb.results == 0
    # Not reported either. The run already said its piece; a second READY frame
    # over a FAILED meeting would be worse than silence.
    assert cb.statuses == []


def test_a_meeting_that_was_deleted_is_not_transcribed():
    # What Stop leaves behind. The worker used to transcribe the whole recording
    # and only then discover, in applyResult, that there was nothing to write it
    # to -- a full bill for a meeting the user had cancelled.
    cb = RecordingCallback(state=JobState(status="", attempt=0, missing=True))

    assert drive(worker(cb), _never_runs) is Outcome.COMMIT
    assert cb.results == 0


def test_a_run_a_reprocess_has_replaced_is_skipped():
    # The reprocess enqueued its own message; finishing this one would produce a
    # result applyResult is going to refuse anyway.
    cb = RecordingCallback(state=JobState(status="TRANSCRIBING", attempt=4))

    assert drive(worker(cb), _never_runs) is Outcome.COMMIT


def test_a_reprocess_is_processed_rather_than_skipped():
    """A reprocess of a meeting that has already been READY once.

    `MeetingService.reprocess` moves the status to QUEUED and bumps the attempt
    in one transaction, and the outbox publishes after that commits -- so the
    row this reads says (QUEUED, 2), never (READY, 2). It has to be processed:
    skipping it would leave the meeting on its old transcript with a QUEUED
    badge and nobody coming back for it, having charged the user for the run.
    """
    cb = RecordingCallback(state=JobState(status="QUEUED", attempt=2))
    event = MeetingUploadedEvent(
        meetingId="mtg_1", userId="usr_1",
        objectKey="meetings/usr_1/mtg_1/audio.m4a",
        processingAttempt=2,
    )

    assert drive(worker(cb), _succeeds, event=event) is Outcome.COMMIT
    assert cb.results == 1


def test_terminal_is_judged_per_run_and_not_by_status_alone():
    """Why `pointless_for` takes the run at all.

    READY on the row is only a reason to stop if it is *this* run's READY. A
    guard written as "status is terminal, skip" would read the previous run's
    result and refuse to do the new one -- so this pins the pairing rather than
    the status.
    """
    # Same status, opposite answers, and the run is the only difference.
    assert JobState(status="READY", attempt=1).pointless_for(1) is not None
    assert JobState(status="READY", attempt=1).pointless_for(2) is None


def test_an_unreachable_spring_processes_the_meeting_anyway():
    """Fails open, and the direction is the whole point.

    A meeting billed twice is a cost. A meeting never processed is a bug that
    leaves somebody's recording in QUEUED for ever with nothing coming back for
    it -- which is the exact failure the hand-committed offset was introduced to
    eliminate, and it must not be reintroduced by an optimisation.
    """
    cb = RecordingCallback(state=None)
    cb.state = None  # what job_state returns when Spring cannot be reached

    assert drive(worker(cb), _succeeds) is Outcome.COMMIT
    assert cb.results == 1


def test_the_state_is_read_once_per_delivery():
    cb = RecordingCallback()

    drive(worker(cb), _succeeds)

    assert cb.state_reads == 1
