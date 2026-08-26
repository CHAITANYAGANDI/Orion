"""Resilient Kafka worker (aiokafka).

Consumes `meeting_uploaded`, runs the full pipeline, and posts every stage to
Spring's status callback. On completion it posts the `MeetingBriefResult` to
Spring's result callback; on failure it posts a FAILED status the same way.

Consume-only. The worker used to also produce a `StatusEvent` to a topic per
stage, and `meeting_processing_failed` on the way out. Nothing consumed them
except a Spring listener that logged them, while the HTTP callbacks beside each
one did the actual work -- persisting the transcript, the summary, and the
FAILED state. The topics were deleted; the callbacks are untouched.

**Offsets are committed by hand, after the outcome is durable.**

This used to run with `enable_auto_commit=True`, which was silent data loss.
aiokafka's background committer advances the offset from the consumer position,
and the position moves when a message is handed to the loop -- not when the loop
finishes with it. A twelve-minute transcription was therefore acknowledged about
five seconds in, so a worker that died at minute six came back with the offset
already committed and never processed that meeting again. It stayed QUEUED
forever: no retry, no FAILED state, nothing in the bell. The outbox went to real
trouble to deliver the job at least once and the consumer threw it away.

Now nothing is acknowledged until the meeting has reached a state Spring has
written down:

  * success  -- committed once `post_result` is accepted. That callback is what
                persists the transcript, summary, action items and READY status,
                so it *is* the terminal state. The READY status post after it is
                a WebSocket courtesy, and its failure does not hold the offset:
                the browser polls the meeting anyway, and redelivering a whole
                transcription to re-send one frame would cost real money.
  * failure  -- committed once the FAILED status callback is accepted, because
                that is what records the error and tells the user.
  * neither  -- not committed. The message is redelivered.

That makes delivery honestly at-least-once, so the effects on the Spring side
are idempotent per processing attempt (V57). This is not exactly-once and does
not pretend to be: a redelivery re-runs transcription, and the provider bills
for it.

**The processing run travels with the message.** `meeting_uploaded` carries the
`processingAttempt` Spring allocated when it created the job, and every callback
this worker sends quotes it back. It is read once, from the message, and never
recomputed: retries, redeliveries and a second pass through the audio-fallback
are all the same run, and only `MeetingService.reprocess` ever starts a new one.
The number is what lets Spring tell a result that is late from a result that is
obsolete, which are the same HTTP request and opposite instructions.

**The consumer stays in the group while a meeting is being processed**, and
there are two separate ways it used not to.

`max_poll_interval_ms` is configured rather than defaulted, because aiokafka's
default is five minutes and Recallix supports meetings that take longer than
that. Its heartbeat task measures `fetcher_idle_time` — time since the last
message was handed to this loop — and leaves the group once that passes the
interval, so a long transcription used to be evicted mid-run, fail its commit,
and be redelivered to be transcribed again, for ever. See `Settings`.

That fixed the poll timer and left the *session* timer, which is a different
clock and was the one that kept firing. The heartbeat is a coroutine on this
event loop, and speaker refinement used to run its ffmpeg decode and its ECAPA
forward passes synchronously on that same loop — nine minutes in one observed
meeting. The heartbeat was never scheduled, the broker declared the member dead
after ten seconds, the group rebalanced, and the offset went uncommitted: the
meeting was redelivered and transcribed again. One upload was transcribed three
times, and its status walked backwards from EXTRACTING to TRANSCRIBING in front
of the person waiting for it. No timeout value can fix that, because the problem
is a coroutine that is never given the loop; the blocking work runs in a thread
now (`rediarize._refine`, `speaker_identity._voiceprints`), and
`kafka_session_timeout_ms` is the margin beside it.

**A redelivery no longer costs a transcription.** Before any work is done,
`_handle` asks Spring what state the meeting is in — see
`SpringCallbackClient.job_state`. A meeting that was deleted, that already
finished this run, or that a reprocess has moved past is committed and skipped.
The check fails open: if Spring cannot be reached the message is processed,
because a meeting billed twice is a cost and a meeting never processed is a bug.

Connection is resilient: if the broker is unreachable at startup the worker logs
and retries with exponential backoff — it never crashes the app.
"""

from __future__ import annotations

import asyncio
import json
import logging
from enum import Enum

import httpx

from app.callback import RETRYABLE_STATUS, Delivery, SpringCallbackClient
from app.config import Settings
from app.pipeline import PROGRESS_DONE, Pipeline
from app.schemas import (
    MeetingUploadedEvent,
    StatusEvent,
)
from app.providers.assemblyai_adapter import (
    AudioUnreachableError,
    TranscriptionConfigurationError,
    TranscriptionRequest,
)
from app.storage import fetch_audio, presigned_get_url

logger = logging.getLogger("ai-service.kafka")


class Outcome(Enum):
    """What the loop should do with the message it just handed over."""

    #: A terminal state — READY or FAILED — is recorded in Postgres.
    COMMIT = "commit"
    #: Nothing durable was established. Leave the offset where it is.
    RETRY = "retry"


def is_retryable(exc: BaseException) -> bool:
    """Whether redelivering this message could plausibly do better.

    The default is *retryable*. An unrecognised exception is far more often a
    blip than a permanently poisoned recording, and the bounded attempt count in
    the loop is what stops a genuinely broken message being retried forever —
    which matters, because `meeting_uploaded` has one partition and a message
    that is never committed blocks every meeting behind it.
    """
    if isinstance(exc, TranscriptionConfigurationError):
        # Its own docstring: "The request Recallix built was refused. Retrying
        # it will not help."
        return False
    if isinstance(exc, AudioUnreachableError):
        # Only escapes when the byte-upload fallback has already been tried, so
        # there is no second path left to take.
        return False
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        return code >= 500 or code in RETRYABLE_STATUS
    if isinstance(exc, (httpx.TransportError, asyncio.TimeoutError, ConnectionError, OSError)):
        return True
    return True


def _partition_of(msg):
    """The TopicPartition a message came from.

    aiokafka is imported lazily throughout this module so the service starts
    without it installed; this keeps that property.
    """
    from aiokafka import TopicPartition

    return TopicPartition(msg.topic, msg.partition)


def _default_ssl_context():
    """A verifying TLS context using the system trust store.

    Built here rather than left to aiokafka's default because that default is
    an *unverified* context — fine against a broker on the same private
    network, wrong against one reached over the public internet.
    """
    import ssl

    return ssl.create_default_context()


class KafkaWorker:
    """Background consumer/producer wired to the pipeline."""

    def __init__(
        self,
        settings: Settings,
        pipeline: Pipeline,
        callback: SpringCallbackClient,
        rag=None,
        *,
        max_attempts: int = 5,
        retry_backoff_seconds: float = 5.0,
    ) -> None:
        self._settings = settings
        self._pipeline = pipeline
        self._callback = callback
        self._rag = rag
        self._consumer = None  # type: ignore[var-annotated]
        self._task: asyncio.Task | None = None
        self._stopped = asyncio.Event()
        # How many times one message may fail retryably before it is treated as
        # terminal. Bounded on purpose: the topic has a single partition, so an
        # uncommitted message is not merely stuck itself, it is a queue head
        # that every later meeting is waiting behind.
        self._max_attempts = max(1, max_attempts)
        self._retry_backoff_seconds = max(0.0, retry_backoff_seconds)
        #: offset -> failures so far, cleared when the offset is committed.
        self._attempts: dict[tuple[str, int, int], int] = {}

    # --- lifecycle ---------------------------------------------------------- #
    def start(self) -> None:
        """Launch the run loop as a background task (non-blocking)."""
        self._task = asyncio.create_task(self._run(), name="kafka-worker")

    async def stop(self) -> None:
        self._stopped.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        if self._consumer is not None:
            try:
                await self._consumer.stop()
            except Exception:  # noqa: BLE001
                pass

    def _security_kwargs(self) -> dict:
        """Broker auth for the consumer.

        Returns nothing at all for a plaintext broker, so the local path builds
        exactly the client it built before. SASL credentials are attached only
        when the protocol asks for them: passing a username to a PLAINTEXT
        client is an error rather than a no-op.
        """
        protocol = (self._settings.kafka_security_protocol or "PLAINTEXT").upper()
        if protocol == "PLAINTEXT":
            return {}
        kwargs: dict = {"security_protocol": protocol}
        if "SASL" in protocol:
            kwargs["sasl_mechanism"] = self._settings.kafka_sasl_mechanism
            kwargs["sasl_plain_username"] = self._settings.kafka_sasl_username
            kwargs["sasl_plain_password"] = self._settings.kafka_sasl_password
        if protocol.endswith("SSL"):
            # aiokafka builds a default verifying context when handed None,
            # which is what a managed broker with a public CA needs.
            kwargs["ssl_context"] = _default_ssl_context()
        return kwargs

    # --- resilient connect -------------------------------------------------- #
    async def _connect(self) -> bool:
        """Try to start the consumer. Returns True on success."""
        from aiokafka import AIOKafkaConsumer

        security = self._security_kwargs()
        self._consumer = AIOKafkaConsumer(
            self._settings.kafka_topic_meeting_uploaded,
            bootstrap_servers=self._settings.kafka_bootstrap_servers,
            group_id=self._settings.kafka_consumer_group,
            value_deserializer=lambda v: json.loads(v.decode("utf-8")),
            # Committed by hand in `_consume_loop`, once the outcome is
            # durable. See the module docstring for what auto-commit did.
            enable_auto_commit=False,
            auto_offset_reset="earliest",
            # Long enough for the longest meeting this product accepts. Left at
            # its default, aiokafka evicted the consumer five minutes into every
            # long transcription; see the module docstring.
            max_poll_interval_ms=self._settings.kafka_max_poll_interval_ms,
            # The heartbeat pair, configured rather than defaulted. Blocking
            # work is off the event loop now, so the heartbeat coroutine is
            # scheduled; these give it room to be late without the group
            # deciding this worker has died. See `Settings`.
            session_timeout_ms=self._settings.kafka_session_timeout_ms,
            heartbeat_interval_ms=self._settings.kafka_heartbeat_interval_ms,
            **security,
        )
        await self._consumer.start()
        return True

    async def _run(self) -> None:
        delay = 2.0
        max_delay = 30.0
        while not self._stopped.is_set():
            try:
                await self._connect()
                logger.info(
                    "Kafka worker connected to %s; consuming '%s'.",
                    self._settings.kafka_bootstrap_servers,
                    self._settings.kafka_topic_meeting_uploaded,
                )
                delay = 2.0  # reset backoff after a good connection
                await self._consume_loop()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — resilient: log + backoff + retry.
                logger.warning(
                    "Kafka unavailable (%s); retrying in %.0fs.", exc, delay
                )
                await self._cleanup_clients()
                try:
                    await asyncio.wait_for(self._stopped.wait(), timeout=delay)
                except asyncio.TimeoutError:
                    pass
                delay = min(delay * 2, max_delay)

    async def _cleanup_clients(self) -> None:
        if self._consumer is not None:
            try:
                await self._consumer.stop()
            except Exception:  # noqa: BLE001
                pass
        self._consumer = None

    async def _consume_loop(self) -> None:
        assert self._consumer is not None
        async for msg in self._consumer:
            if self._stopped.is_set():
                break
            key = (msg.topic, msg.partition, msg.offset)

            try:
                event = MeetingUploadedEvent.model_validate(msg.value)
            except Exception as exc:  # noqa: BLE001
                # Unreadable, and there is no meeting id to report a failure
                # against. Committed rather than retried: it cannot ever
                # succeed, and leaving it uncommitted on a single-partition
                # topic would stop every meeting behind it.
                logger.exception("Discarding unreadable meeting_uploaded message: %s", exc)
                await self._commit(msg)
                continue

            failures = self._attempts.get(key, 0)
            try:
                outcome = await self._handle(event, failures=failures)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — one bad message must not kill the loop.
                logger.exception("Failed handling meeting_uploaded message: %s", exc)
                outcome = Outcome.RETRY

            if outcome is Outcome.COMMIT:
                self._attempts.pop(key, None)
                await self._commit(msg)
                continue

            self._attempts[key] = failures + 1
            logger.warning(
                "Leaving %s uncommitted for redelivery (failure %d of %d).",
                event.meeting_id, failures + 1, self._max_attempts,
            )
            if not await self._pause_before_retry():
                break
            # Rewind so this session re-reads the message. Without it the
            # position has already moved on and the redelivery would only
            # happen at the next rebalance or restart.
            try:
                self._consumer.seek(_partition_of(msg), msg.offset)
            except Exception as exc:  # noqa: BLE001
                # The partition is no longer ours -- a rebalance happened while
                # we were backing off. The offset is uncommitted either way, so
                # whoever holds the partition next reads this message again.
                logger.warning("Could not rewind to offset %d: %s", msg.offset, exc)
                break

    async def _pause_before_retry(self) -> bool:
        """Wait out the backoff. False when the worker is shutting down."""
        if self._retry_backoff_seconds <= 0:
            return not self._stopped.is_set()
        try:
            await asyncio.wait_for(self._stopped.wait(), timeout=self._retry_backoff_seconds)
        except asyncio.TimeoutError:
            return True
        return False

    async def _commit(self, msg) -> None:
        """Acknowledge exactly this message, and nothing else in flight."""
        if self._consumer is None:
            return
        try:
            await self._consumer.commit({_partition_of(msg): msg.offset + 1})
        except Exception as exc:  # noqa: BLE001
            # The work is done and recorded in Postgres either way. A failed
            # commit costs a redelivery, which the idempotent callbacks absorb.
            logger.warning("Could not commit offset %d: %s", msg.offset, exc)

    # --- message handling --------------------------------------------------- #
    async def _process_source(self, event, progress_hook, transcript_hook):
        """Fetch the recording and run it through the pipeline.

        One source. YouTube links and PDFs used to converge here too — the first
        downloaded to audio and transcribed, the second skipped transcription
        because it was already text — and both are gone: Recallix transcribes
        recordings, and a document was never a meeting anybody attended.
        """
        # None means "no preference", which is what the adapters read as
        # detect-the-language.
        language = (event.language or "").strip() or None

        # Meetings imported before those sources were withdrawn are still in
        # the database and still open and read fine. Reprocessing one cannot
        # work — a YOUTUBE row has no stored object to fetch and a DOCUMENT row
        # has no audio to transcribe — so it is refused in as many words rather
        # than failing later inside the fetch with something unreadable.
        if event.source_type not in ("", None, "AUDIO"):
            raise ValueError(
                f"{event.source_type} meetings can no longer be processed. "
                "Recallix transcribes audio and video recordings only; this "
                "meeting was imported before that changed and can still be read."
            )

        # Ask the provider to fetch the file itself where that is possible.
        # Two whole-file transfers of an hour of audio -- storage to here, here
        # to the provider -- for bytes this process never looks at.
        direct = event.audio_url or presigned_get_url(event.object_key or "", self._settings)

        # Still downloaded when there is no URL to hand over. `fetch_audio`
        # returns empty bytes rather than raising when it has nothing, which is
        # what keeps the mock provider working with no storage at all.
        audio, filename = (b"", event.object_key or "audio")
        if not direct:
            audio, filename = await fetch_audio(
                self._settings, audio_url=event.audio_url, object_key=event.object_key
            )

        def build(url: str | None) -> TranscriptionRequest:
            return TranscriptionRequest.from_event(
                language=language,
                context=event.context,
                speakers=event.speakers,
                multichannel=event.multichannel,
                audio_url=url,
            )

        # Speaker refinement needs the bytes, and the whole point of `direct` is
        # that they were never downloaded. A callable rather than a download:
        # most meetings have no turn long enough to examine, and those pay
        # nothing.
        async def load_audio() -> bytes:
            if audio:
                return audio
            fetched, _ = await fetch_audio(
                self._settings, audio_url=event.audio_url, object_key=event.object_key
            )
            return fetched

        try:
            return await self._pipeline.process(
                event.meeting_id, audio, filename, progress_hook, transcript_hook,
                event.summary_template, language, request=build(direct),
                audio_loader=load_audio,
            )
        except AudioUnreachableError as exc:
            if not direct:
                # Nothing to fall back to; the bytes were already what failed.
                raise
            # The provider could not reach the URL we handed it. Deployments
            # get this wrong in ways that are invisible until a meeting comes
            # back empty -- a bucket that is private to the right people and
            # unreachable by the provider looks identical to a working one
            # until a job runs. Send the bytes instead, which always works.
            logger.warning(
                "Provider could not fetch the audio (%s); falling back to upload.", exc
            )
            audio, filename = await fetch_audio(
                self._settings, audio_url=event.audio_url, object_key=event.object_key
            )
            return await self._pipeline.process(
                event.meeting_id, audio, filename, progress_hook, transcript_hook,
                event.summary_template, language, request=build(None),
                audio_loader=load_audio,
            )

    async def _handle(self, event: MeetingUploadedEvent, *, failures: int = 0) -> Outcome:
        """Run one meeting, and say whether its offset may be acknowledged.

        `failures` is how many times this same message has already failed
        retryably, so a message that cannot be made to work is eventually
        reported as FAILED rather than blocking the partition for ever. It is
        deliberately not the *processing run*: a retry is the same run trying
        again, and calling it a new attempt is exactly the confusion that let a
        late result claim a reprocess's identity.
        """
        meeting_id = event.meeting_id
        # Read once, from the message. Every callback below quotes it, and it is
        # the same number on the fifth redelivery as on the first.
        run = event.processing_attempt

        # Ask before spending anything. Delivery is at-least-once and
        # transcription is billed per run, so a redelivery of a job that already
        # finished used to cost a second full transcription of the same
        # recording -- and the meeting's status walked backwards from EXTRACTING
        # to TRANSCRIBING while somebody watched. Three things make this run
        # pointless: the meeting was deleted, this run already reached a
        # terminal state, or a reprocess replaced it. All three are cheap to
        # find out and expensive to discover afterwards.
        #
        # Fails open. `job_state` returns None when Spring cannot be reached,
        # and the answer to "I don't know" is to do the work: a meeting
        # processed twice is a bill, a meeting never processed is a bug.
        state = await self._callback.job_state(meeting_id)
        pointless = state.pointless_for(run) if state is not None else None
        if pointless:
            logger.info(
                "Skipping meeting_uploaded for %s (run %d): %s.",
                meeting_id, run, pointless,
            )
            return Outcome.COMMIT

        logger.info("Processing meeting_uploaded for %s (run %d).", meeting_id, run)

        async def progress_hook(status_event: StatusEvent) -> None:
            await self._callback.post_status(meeting_id, status_event, attempt=run)

        # Index into pgvector the moment the transcript exists, concurrently with
        # summarization/extraction, so RAG chat is queryable as soon as the
        # meeting flips to READY instead of seconds after it.
        index_task: asyncio.Task | None = None

        async def transcript_hook(transcript) -> None:
            nonlocal index_task
            if self._rag is None:
                return
            index_task = asyncio.create_task(
                # Tagged with this run. pgvector is the one piece of derived
                # state Spring does not write, so the attempt check in
                # `applyResult` cannot protect it -- indexing happens here,
                # minutes before the result callback exists. Carrying the run
                # down is what stops an overtaken execution replacing the chunks
                # a newer one has already written.
                self._rag.index(
                    meeting_id, event.user_id, transcript.transcript,
                    transcript.segments, run,
                ),
                name=f"rag-index-{meeting_id}-run{run}",
            )

        try:
            result = await self._process_source(event, progress_hook, transcript_hook)

            # The durable terminal boundary. `CallbackService.applyResult`
            # writes the transcript, segments, summary, action items and the
            # READY status in one transaction, and charges the attempt. Until
            # it is accepted, nothing about this run exists outside this
            # process, so nothing may be acknowledged.
            delivery = await self._callback.post_result(meeting_id, result, attempt=run)
            if delivery is Delivery.UNDELIVERED:
                if index_task is not None and not index_task.done():
                    index_task.cancel()
                logger.warning(
                    "Result callback for %s was not accepted; leaving it for redelivery.",
                    meeting_id,
                )
                return Outcome.RETRY
            if delivery is Delivery.REFUSED:
                # Spring read it and declined it -- this run has been overtaken
                # by a reprocess, or the payload is one it will never take.
                # Either way it changed nothing and it will change nothing next
                # time, so this message is finished. Nothing is reported as
                # FAILED: the meeting either belongs to a newer run or is in a
                # state a person needs to look at, and neither is improved by
                # this execution writing an error onto it.
                if index_task is not None and not index_task.done():
                    index_task.cancel()
                logger.warning(
                    "Spring refused the result for %s (run %d); the message is done.",
                    meeting_id, run,
                )
                return Outcome.COMMIT

            # Indexing started during analysis; make sure it landed before READY.
            if index_task is not None:
                await index_task
            ready = StatusEvent(
                meeting_id=meeting_id, status="READY", progress=PROGRESS_DONE,
                message="Meeting brief ready.",
            )
            # Best effort, deliberately. The meeting is already READY in
            # Postgres; this frame only saves the browser a poll, and holding
            # the offset for it would re-run a paid transcription to redeliver
            # a notification.
            if not (await self._callback.post_status(
                    meeting_id, ready, attempt=run)).accepted:
                logger.warning(
                    "READY status frame for %s was not delivered; the meeting is "
                    "READY in Postgres and the client will poll it.", meeting_id,
                )
            logger.info("Finished processing meeting %s.", meeting_id)
            return Outcome.COMMIT
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            if index_task is not None and not index_task.done():
                index_task.cancel()

            retryable = is_retryable(exc)
            if retryable and failures + 1 < self._max_attempts:
                logger.warning(
                    "Processing %s failed retryably (%s: %s); leaving it for redelivery.",
                    meeting_id, type(exc).__name__, exc,
                )
                return Outcome.RETRY

            if retryable:
                logger.error(
                    "Processing %s failed %d times; recording it as failed rather than "
                    "holding the partition.", meeting_id, failures + 1,
                )
            logger.exception("Processing failed for %s: %s", meeting_id, exc)
            # The only report of a failure. This is what sets FAILED in
            # Postgres, records the message, raises the bell notification and
            # pushes the status frame -- see CallbackService.applyStatus.
            delivered = await self._callback.post_status(
                meeting_id,
                # 100, not 0. A failure is where this meeting's progress ends,
                # and sending 0 asked the bar to rewind to empty and sit there
                # looking like a job that had not started — next to a card
                # saying it had failed.
                StatusEvent(
                    meeting_id=meeting_id, status="FAILED", progress=PROGRESS_DONE,
                    message=str(exc),
                ),
                attempt=run,
            )
            if delivered is Delivery.UNDELIVERED:
                # The failure is real but nobody has been told. Acknowledging
                # now would lose it exactly the way auto-commit used to.
                logger.warning(
                    "FAILED status for %s was not accepted; leaving it for redelivery.",
                    meeting_id,
                )
                return Outcome.RETRY
            if delivered is Delivery.REFUSED:
                # An overtaken run failing is not news, and must not be written
                # over the run that replaced it. Finished, quietly.
                logger.warning(
                    "Spring refused the FAILED status for %s (run %d); the message is done.",
                    meeting_id, run,
                )
            return Outcome.COMMIT
