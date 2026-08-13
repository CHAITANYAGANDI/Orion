"""Resilient Kafka worker (aiokafka).

Consumes `meeting_uploaded`, runs the full pipeline, and for every stage emits a
`StatusEvent` to the matching topic (§6) AND posts it to Spring's status
callback. On completion it posts the `MeetingBriefResult` to Spring's result
callback. On failure it emits `meeting_processing_failed`.

Connection is resilient: if the broker is unreachable at startup the worker logs
and retries with exponential backoff — it never crashes the app.
"""

from __future__ import annotations

import asyncio
import json
import logging

from app.callback import SpringCallbackClient
from app.config import Settings
from app.ingest import extract_pdf_text, fetch_youtube
from app.pipeline import TOPIC_TRANSCRIPTION_STARTED, Pipeline
from app.schemas import (
    MeetingUploadedEvent,
    ProcessingFailedEvent,
    StatusEvent,
)
from app.storage import fetch_audio

logger = logging.getLogger("ai-service.kafka")

TOPIC_PROCESSING_FAILED = "meeting_processing_failed"


def _json_serializer(value: dict) -> bytes:
    return json.dumps(value).encode("utf-8")


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
    ) -> None:
        self._settings = settings
        self._pipeline = pipeline
        self._callback = callback
        self._rag = rag
        self._consumer = None  # type: ignore[var-annotated]
        self._producer = None  # type: ignore[var-annotated]
        self._task: asyncio.Task | None = None
        self._stopped = asyncio.Event()

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
        if self._producer is not None:
            try:
                await self._producer.stop()
            except Exception:  # noqa: BLE001
                pass

    def _security_kwargs(self) -> dict:
        """Broker auth, shared by the consumer and the producer.

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
        """Try to start consumer + producer. Returns True on success."""
        from aiokafka import AIOKafkaConsumer, AIOKafkaProducer

        security = self._security_kwargs()
        self._producer = AIOKafkaProducer(
            bootstrap_servers=self._settings.kafka_bootstrap_servers,
            value_serializer=_json_serializer,
            key_serializer=lambda k: (k or "").encode("utf-8"),
            **security,
        )
        self._consumer = AIOKafkaConsumer(
            self._settings.kafka_topic_meeting_uploaded,
            bootstrap_servers=self._settings.kafka_bootstrap_servers,
            group_id=self._settings.kafka_consumer_group,
            value_deserializer=lambda v: json.loads(v.decode("utf-8")),
            enable_auto_commit=True,
            auto_offset_reset="earliest",
            **security,
        )
        await self._producer.start()
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
        for client in (self._consumer, self._producer):
            if client is not None:
                try:
                    await client.stop()
                except Exception:  # noqa: BLE001
                    pass
        self._consumer = None
        self._producer = None

    async def _consume_loop(self) -> None:
        assert self._consumer is not None
        async for msg in self._consumer:
            if self._stopped.is_set():
                break
            try:
                event = MeetingUploadedEvent.model_validate(msg.value)
                await self._handle(event)
            except Exception as exc:  # noqa: BLE001 — one bad message must not kill the loop.
                logger.exception("Failed handling meeting_uploaded message: %s", exc)

    # --- message handling --------------------------------------------------- #
    async def _emit(self, topic: str, key: str, value: dict) -> None:
        if self._producer is None:
            return
        try:
            await self._producer.send_and_wait(topic, value=value, key=key)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to emit to %s: %s", topic, exc)

    async def _process_source(self, event, progress_hook, transcript_hook):
        """Resolve the event's source, then run the matching pipeline.

        Three sources converge here. AUDIO and YOUTUBE both end up as bytes and
        transcribe; DOCUMENT is already text, so it enters the pipeline after
        transcription rather than before it.
        """
        meeting_id = event.meeting_id
        template_slug = event.summary_template
        # None rather than [] so adapters can distinguish "no hints" from an
        # empty list without each of them re-checking for falsiness.
        vocabulary = event.vocabulary or None

        if event.source_type == "YOUTUBE":
            await progress_hook(
                TOPIC_TRANSCRIPTION_STARTED,
                StatusEvent(
                    meeting_id=meeting_id, status="TRANSCRIBING", progress=5,
                    message="Downloading audio from YouTube...",
                ),
            )
            source = await fetch_youtube(event.source_url or "", self._settings)
            result = await self._pipeline.process(
                meeting_id, source.audio or b"", source.filename, progress_hook,
                transcript_hook, template_slug, vocabulary,
            )
            # Spring created this meeting before anything was known about the
            # video; hand back the real title and length so it can replace them.
            result.title = source.title
            result.duration_seconds = source.duration_seconds
            return result

        if event.source_type == "DOCUMENT":
            await progress_hook(
                TOPIC_TRANSCRIPTION_STARTED,
                StatusEvent(
                    meeting_id=meeting_id, status="TRANSCRIBING", progress=10,
                    message="Reading document...",
                ),
            )
            data, filename = await fetch_audio(
                self._settings, audio_url=event.audio_url, object_key=event.object_key
            )
            source = extract_pdf_text(data, self._settings, filename)
            # No title backfill here: Spring already derived one from the
            # uploaded filename, and the user may have edited it since.
            return await self._pipeline.process_document(
                meeting_id, source.text or "", progress_hook, transcript_hook,
                template_slug=template_slug,
            )

        audio, filename = await fetch_audio(
            self._settings, audio_url=event.audio_url, object_key=event.object_key
        )
        return await self._pipeline.process(
            meeting_id, audio, filename, progress_hook, transcript_hook,
            template_slug, vocabulary,
        )

    async def _handle(self, event: MeetingUploadedEvent) -> None:
        meeting_id = event.meeting_id
        logger.info("Processing meeting_uploaded for %s.", meeting_id)

        async def progress_hook(topic: str, status_event: StatusEvent) -> None:
            payload = status_event.model_dump(by_alias=True)
            await self._emit(topic, meeting_id, payload)
            await self._callback.post_status(meeting_id, status_event)

        # Index into pgvector the moment the transcript exists, concurrently with
        # summarization/extraction, so RAG chat is queryable as soon as the
        # meeting flips to READY instead of seconds after it.
        index_task: asyncio.Task | None = None

        async def transcript_hook(transcript) -> None:
            nonlocal index_task
            if self._rag is None:
                return
            index_task = asyncio.create_task(
                self._rag.index(
                    meeting_id, event.user_id, transcript.transcript, transcript.segments
                ),
                name=f"rag-index-{meeting_id}",
            )

        try:
            result = await self._process_source(event, progress_hook, transcript_hook)

            # Persist final result + READY status.
            await self._callback.post_result(meeting_id, result)

            # Indexing started during analysis; make sure it landed before READY.
            if index_task is not None:
                await index_task
            ready = StatusEvent(
                meeting_id=meeting_id, status="READY", progress=100, message="Meeting brief ready."
            )
            await self._callback.post_status(meeting_id, ready)
            logger.info("Finished processing meeting %s.", meeting_id)
        except Exception as exc:  # noqa: BLE001
            if index_task is not None and not index_task.done():
                index_task.cancel()
            logger.exception("Processing failed for %s: %s", meeting_id, exc)
            failed = ProcessingFailedEvent(meeting_id=meeting_id, error=str(exc))
            await self._emit(TOPIC_PROCESSING_FAILED, meeting_id, failed.model_dump(by_alias=True))
            await self._callback.post_status(
                meeting_id,
                StatusEvent(meeting_id=meeting_id, status="FAILED", progress=0, message=str(exc)),
            )
