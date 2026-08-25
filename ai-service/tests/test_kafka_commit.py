"""When the worker is allowed to acknowledge a message, and when it is not.

The failure this replaces was silent. With `enable_auto_commit=True` the offset
advanced about five seconds after the message was handed to the loop, so a
worker that died during a twelve-minute transcription came back with the job
already acknowledged and never ran it again — the meeting sat in QUEUED with no
error, no retry and nothing in the bell.

Every test here is about the boundary that replaced it: an offset is committed
only once Spring has written down a terminal outcome.

Nothing sleeps for a real backoff; the worker takes its own timings so the
tests can set them to zero.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import httpx
import pytest

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

    def __init__(self, *, result_ok: bool = True, status_ok: bool = True) -> None:
        self.result_ok = result_ok
        self.status_ok = status_ok
        self.statuses: list[str] = []
        self.results = 0

    async def post_result(self, meeting_id, result) -> bool:
        self.results += 1
        return self.result_ok

    async def post_status(self, meeting_id, event) -> bool:
        self.statuses.append(event.status)
        return self.status_ok


def worker(callback, *, max_attempts: int = 5) -> KafkaWorker:
    return KafkaWorker(
        settings=SimpleNamespace(
            kafka_bootstrap_servers="localhost:9092",
            kafka_topic_meeting_uploaded="meeting_uploaded",
            kafka_consumer_group="ai-service",
            kafka_security_protocol="PLAINTEXT",
        ),
        pipeline=None,
        callback=callback,
        rag=None,
        max_attempts=max_attempts,
        retry_backoff_seconds=0.0,
    )


def drive(w: KafkaWorker, process, *, attempt: int = 0) -> Outcome:
    """Run one message through `_handle` with the pipeline stubbed out."""
    w._process_source = process  # noqa: SLF001 — the seam under test is around it
    return asyncio.run(w._handle(EVENT, attempt=attempt))  # noqa: SLF001


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
    cb = RecordingCallback(result_ok=False)

    assert drive(worker(cb), _succeeds) is Outcome.RETRY
    assert "READY" not in cb.statuses


def test_a_lost_ready_frame_does_not_hold_the_offset():
    # applyResult has already persisted the brief and flipped the meeting to
    # READY, so the terminal state exists. Redelivering the whole meeting to
    # re-send one WebSocket frame would re-run a paid transcription.
    class ResultYesStatusNo(RecordingCallback):
        async def post_status(self, meeting_id, event) -> bool:
            self.statuses.append(event.status)
            return False

    cb = ResultYesStatusNo()
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

    cb = RecordingCallback(status_ok=False)
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

    assert drive(w, transient, attempt=0) is Outcome.RETRY
    assert drive(w, transient, attempt=1) is Outcome.RETRY
    # The third failure gives up and records it, rather than holding the queue.
    assert drive(w, transient, attempt=2) is Outcome.COMMIT
    assert cb.statuses[-1] == "FAILED"


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
