"""The processing run belongs to the message, and outlives every retry of it.

Spring allocates a run number when it creates the job and puts it on
`meeting_uploaded`. This worker reads it once and quotes it back on every
callback, so Spring can tell a result that is merely late from one that a
reprocess has made obsolete — they are the same HTTP request and they call for
opposite handling.

The rule these tests defend is that nothing in the worker ever invents or
advances a run. A retry is the same run trying again; a redelivery is the same
run arriving again; only a person pressing reprocess starts a new one.

The second half is about staying in the consumer group long enough to finish.
"""

from __future__ import annotations

import asyncio
import sys
from types import ModuleType, SimpleNamespace

import httpx
import pytest

from app.callback import Delivery
from app.config import Settings
from app.kafka_worker import KafkaWorker, Outcome
from app.providers.assemblyai_adapter import TranscriptionConfigurationError
from app.schemas import MeetingUploadedEvent


def event(attempt: int | None = None) -> MeetingUploadedEvent:
    payload = {
        "meetingId": "mtg_1",
        "userId": "usr_1",
        "objectKey": "meetings/usr_1/mtg_1/audio.m4a",
    }
    if attempt is not None:
        payload["processingAttempt"] = attempt
    return MeetingUploadedEvent.model_validate(payload)


class RecordingCallback:
    def __init__(
        self,
        *,
        result: Delivery = Delivery.ACCEPTED,
        status: Delivery = Delivery.ACCEPTED,
    ) -> None:
        self.result_delivery = result
        self.status_delivery = status
        #: (kind, status-or-None, attempt) in the order they were sent.
        self.sent: list[tuple[str, str | None, int | None]] = []

    async def post_result(self, meeting_id, result, *, attempt=None) -> Delivery:
        self.sent.append(("result", None, attempt))
        return self.result_delivery

    async def post_status(self, meeting_id, ev, *, attempt=None) -> Delivery:
        self.sent.append(("status", ev.status, attempt))
        return self.status_delivery

    def attempts(self) -> set[int | None]:
        return {a for _, _, a in self.sent}


def worker(callback, *, max_attempts: int = 5) -> KafkaWorker:
    return KafkaWorker(
        settings=SimpleNamespace(
            kafka_bootstrap_servers="localhost:9092",
            kafka_topic_meeting_uploaded="meeting_uploaded",
            kafka_consumer_group="ai-service",
            kafka_security_protocol="PLAINTEXT",
            kafka_max_poll_interval_ms=6_000_000,
        ),
        pipeline=None,
        callback=callback,
        rag=None,
        max_attempts=max_attempts,
        retry_backoff_seconds=0.0,
    )


def drive(w, process, *, failures: int = 0, ev=None) -> Outcome:
    w._process_source = process  # noqa: SLF001
    return asyncio.run(w._handle(ev or event(1), failures=failures))  # noqa: SLF001


async def _succeeds(ev, progress_hook, transcript_hook):
    await progress_hook(SimpleNamespace(status="TRANSCRIBING", progress=30, message=""))
    return SimpleNamespace(transcript="hello", segments=[])


# --------------------------------------------------------------------------- #
# The event carries the run
# --------------------------------------------------------------------------- #
def test_an_event_without_a_run_is_the_first_one():
    # Not "whatever the meeting is on now". A message published before this
    # field existed cannot be the current run of a meeting somebody has
    # reprocessed since, and reading it as the current one is exactly how an
    # obsolete execution would overwrite a fresh one.
    assert event().processing_attempt == 1


def test_the_run_on_the_event_is_the_run_on_every_callback():
    cb = RecordingCallback()

    assert drive(worker(cb), _succeeds, ev=event(4)) is Outcome.COMMIT

    assert cb.attempts() == {4}
    # Progress, result and READY, all speaking for run 4.
    assert [kind for kind, _, _ in cb.sent] == ["status", "result", "status"]


def test_a_failure_reports_the_run_that_failed():
    async def broken(ev, progress_hook, transcript_hook):
        raise TranscriptionConfigurationError("that parameter is not valid")

    cb = RecordingCallback()
    assert drive(worker(cb), broken, ev=event(7)) is Outcome.COMMIT

    assert cb.sent[-1] == ("status", "FAILED", 7)


# --------------------------------------------------------------------------- #
# Nothing in the worker advances it
# --------------------------------------------------------------------------- #
def test_a_transient_retry_is_the_same_run_trying_again():
    async def transient(ev, progress_hook, transcript_hook):
        raise httpx.ConnectError("connection reset")

    cb = RecordingCallback()
    w = worker(cb, max_attempts=3)
    ev = event(3)

    assert drive(w, transient, failures=0, ev=ev) is Outcome.RETRY
    assert drive(w, transient, failures=1, ev=ev) is Outcome.RETRY
    assert drive(w, transient, failures=2, ev=ev) is Outcome.COMMIT

    # Three goes at run 3, not runs 3, 4 and 5.
    assert cb.attempts() == {3}


def test_a_redelivery_is_the_same_run_arriving_again(monkeypatch):
    # The full loop, because this is where an "attempt" counter could plausibly
    # have been minted per delivery. The same message body is handed over twice;
    # both executions must speak for run 5.
    monkeypatch.setattr("app.kafka_worker._partition_of", lambda msg: (msg.topic, msg.partition))

    body = event(5).model_dump(by_alias=True)
    messages = [
        SimpleNamespace(topic="meeting_uploaded", partition=0, offset=11, value=dict(body)),
        SimpleNamespace(topic="meeting_uploaded", partition=0, offset=11, value=dict(body)),
    ]

    class FakeConsumer:
        def __init__(self):
            self.committed: list[dict] = []

        def __aiter__(self):
            async def gen():
                for m in messages:
                    yield m
            return gen()

        async def commit(self, offsets):
            self.committed.append(offsets)

        def seek(self, tp, offset):  # pragma: no cover — success path never rewinds
            raise AssertionError("a successful message must not be rewound")

    cb = RecordingCallback()
    w = worker(cb)
    w._process_source = _succeeds  # noqa: SLF001
    w._consumer = FakeConsumer()  # noqa: SLF001
    asyncio.run(w._consume_loop())  # noqa: SLF001

    assert cb.attempts() == {5}
    # Committed twice, at the offset after the message, both times.
    assert w._consumer.committed == [  # noqa: SLF001
        {("meeting_uploaded", 0): 12},
        {("meeting_uploaded", 0): 12},
    ]


def test_an_unreadable_message_is_committed_without_inventing_a_run(monkeypatch):
    monkeypatch.setattr("app.kafka_worker._partition_of", lambda msg: (msg.topic, msg.partition))

    class FakeConsumer:
        def __init__(self):
            self.committed: list[dict] = []

        def __aiter__(self):
            async def gen():
                yield SimpleNamespace(
                    topic="meeting_uploaded", partition=0, offset=3, value={"nonsense": True}
                )
            return gen()

        async def commit(self, offsets):
            self.committed.append(offsets)

    cb = RecordingCallback()
    w = worker(cb)
    w._consumer = FakeConsumer()  # noqa: SLF001
    asyncio.run(w._consume_loop())  # noqa: SLF001

    assert w._consumer.committed == [{("meeting_uploaded", 0): 4}]  # noqa: SLF001
    assert cb.sent == []


# --------------------------------------------------------------------------- #
# An overtaken run
# --------------------------------------------------------------------------- #
def test_a_run_spring_has_moved_past_is_finished_not_retried():
    # Spring answers a stale result with a refusal rather than a timeout,
    # because it is a permanent answer: run 1 will still be behind run 2 in ten
    # minutes. Retrying it would hold the only partition open for a message
    # that can never make progress.
    cb = RecordingCallback(result=Delivery.REFUSED)

    assert drive(worker(cb), _succeeds, ev=event(1)) is Outcome.COMMIT

    # It also stops there: no READY frame for a run that was refused.
    assert [s for kind, s, _ in cb.sent if kind == "status"] == ["TRANSCRIBING"]


def test_a_refusal_does_not_report_the_meeting_as_failed():
    # The meeting belongs to a newer run, or to a person who needs to look at
    # it. Writing FAILED onto it from here would be this execution mutating the
    # thing it was just told it has no business mutating.
    cb = RecordingCallback(result=Delivery.REFUSED)

    drive(worker(cb), _succeeds, ev=event(1))

    assert "FAILED" not in [s for _, s, _ in cb.sent]


# --------------------------------------------------------------------------- #
# Staying in the group long enough to finish
# --------------------------------------------------------------------------- #
def _stub_aiokafka(monkeypatch) -> dict:
    """Install a fake `aiokafka` so `_connect` can be run without the package."""
    captured: dict = {}

    class FakeConsumer:
        def __init__(self, *topics, **kwargs):
            captured["topics"] = topics
            captured.update(kwargs)

        async def start(self):
            return None

    module = ModuleType("aiokafka")
    module.AIOKafkaConsumer = FakeConsumer
    module.TopicPartition = tuple
    monkeypatch.setitem(sys.modules, "aiokafka", module)
    return captured


def test_the_consumer_is_given_a_poll_interval_long_enough_to_transcribe(monkeypatch):
    # aiokafka's default is five minutes, measured from the moment a message is
    # handed to the loop. Recallix supports meetings that take longer than that,
    # and the consequence of leaving it alone was not a warning: the consumer
    # left the group mid-transcription, its commit was refused, and the meeting
    # was redelivered to be transcribed and paid for all over again.
    captured = _stub_aiokafka(monkeypatch)
    cb = RecordingCallback()
    w = worker(cb)

    asyncio.run(w._connect())  # noqa: SLF001

    assert captured["max_poll_interval_ms"] == 6_000_000
    assert captured["enable_auto_commit"] is False


def test_the_poll_interval_covers_the_worst_supported_meeting():
    # Derived from the same settings the pipeline is bounded by, so raising one
    # of those timeouts without raising this fails here rather than in
    # production three weeks later.
    s = Settings()

    transcription = s.assemblyai_timeout_seconds * (s.assemblyai_max_retries + 1)
    llm_pass = s.openai_timeout_seconds * (s.openai_max_retries + 1)
    worst_case = (
        transcription          # the floor, and most of the total
        + s.download_timeout_seconds * 2   # fetch, then fetch again for the fallback
        + 120                  # ffmpeg decode for speaker refinement
        + llm_pass             # summarize and extract, concurrently
        + llm_pass             # suggestions
        + llm_pass             # RAG indexing, awaited before READY
        + 30                   # the result and status callbacks
    )

    assert s.kafka_max_poll_interval_ms / 1000 > worst_case
    # And with real margin, not by a second.
    assert s.kafka_max_poll_interval_ms / 1000 >= worst_case * 1.5


@pytest.mark.parametrize("attempt", [1, 2, 99])
def test_any_run_number_survives_a_round_trip_through_the_event(attempt):
    body = event(attempt).model_dump(by_alias=True)
    assert body["processingAttempt"] == attempt
    assert MeetingUploadedEvent.model_validate(body).processing_attempt == attempt
