"""Pipeline orchestration: transcribe -> (summarize | extract) in parallel.

The pipeline is provider-agnostic (it depends only on the ports) and is used by
both the synchronous HTTP endpoints and the async Kafka worker. Progress is
surfaced through an optional `progress_hook(topic, StatusEvent)` so the worker
can fan each stage out to Kafka + the Spring callback, while HTTP callers can
ignore it.

Latency note: summarization and the three extractions all take the same
transcript and are independent of one another, so they run concurrently — the
analysis stage costs the slowest single call rather than the sum of four. The
`transcript_hook` fires the moment the transcript exists, which lets the worker
start RAG indexing in the background while analysis is still running.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Awaitable, Callable

from app.providers.ports import LlmPort, TranscriptionPort
from app.schemas import (
    MeetingBriefResult,
    StatusEvent,
    SummaryResponse,
    TranscriptResponse,
)

logger = logging.getLogger("ai-service.pipeline")

ProgressHook = Callable[[str, StatusEvent], Awaitable[None]]
# Fired as soon as the transcript is ready, before analysis starts.
TranscriptHook = Callable[[TranscriptResponse], Awaitable[None]]

# Kafka topics emitted per stage (api-contracts.md §6).
TOPIC_TRANSCRIPTION_STARTED = "transcription_started"
TOPIC_TRANSCRIPTION_COMPLETED = "transcription_completed"
TOPIC_SUMMARY_GENERATED = "summary_generated"
TOPIC_ACTION_ITEMS_EXTRACTED = "action_items_extracted"


class Pipeline:
    """Coordinates the transcription + LLM ports into a MeetingBriefResult."""

    def __init__(self, transcription: TranscriptionPort, llm: LlmPort) -> None:
        self._transcription = transcription
        self._llm = llm

    # --- individual stages (used directly by HTTP endpoints) ---------------- #
    async def transcribe(self, audio: bytes, filename: str) -> TranscriptResponse:
        return await self._transcription.transcribe(audio, filename)

    async def summarize(self, transcript: str) -> SummaryResponse:
        return await self._llm.summarize(transcript)

    async def extract_action_items(self, transcript: str):
        return await self._llm.extract_action_items(transcript)

    async def extract_decisions(self, transcript: str):
        return await self._llm.extract_decisions(transcript)

    async def extract_risks(self, transcript: str):
        return await self._llm.extract_risks(transcript)

    async def translate(self, text: str, target_language: str) -> str:
        return await self._llm.translate(text, target_language)

    # --- full pipeline ------------------------------------------------------ #
    async def process(
        self,
        meeting_id: str,
        audio: bytes,
        filename: str,
        progress_hook: ProgressHook | None = None,
        transcript_hook: TranscriptHook | None = None,
    ) -> MeetingBriefResult:
        """Run the full pipeline, emitting stage events through the hook."""

        async def emit(topic: str, status: str, progress: int, message: str) -> None:
            if progress_hook is None:
                return
            await progress_hook(
                topic,
                StatusEvent(meeting_id=meeting_id, status=status, progress=progress, message=message),
            )

        started = time.perf_counter()

        # 1) Transcription
        await emit(TOPIC_TRANSCRIPTION_STARTED, "TRANSCRIBING", 10, "Generating transcript from audio...")
        transcript = await self._transcription.transcribe(audio, filename)
        transcribed_at = time.perf_counter()
        await emit(
            TOPIC_TRANSCRIPTION_COMPLETED, "TRANSCRIBING", 40, "Transcript ready; preparing summary..."
        )

        # Let the caller start indexing now — it overlaps with the analysis below
        # so RAG chat is warm the moment the brief is ready.
        if transcript_hook is not None:
            await transcript_hook(transcript)

        # 2) Analysis — summary + all three extractions are independent and run
        #    concurrently. Cost is the slowest call, not the sum of four.
        await emit(TOPIC_SUMMARY_GENERATED, "SUMMARIZING", 60, "Summarizing and extracting insights...")
        text = transcript.transcript
        summary, action_items, decisions, risks = await asyncio.gather(
            self._llm.summarize(text),
            self._llm.extract_action_items(text),
            self._llm.extract_decisions(text),
            self._llm.extract_risks(text),
        )
        analyzed_at = time.perf_counter()
        await emit(TOPIC_ACTION_ITEMS_EXTRACTED, "EXTRACTING", 95, "Insights extracted; finalizing brief...")

        result = MeetingBriefResult(
            meeting_id=meeting_id,
            transcript=transcript.transcript,
            language=transcript.language,
            segments=transcript.segments,
            short_summary=summary.short_summary,
            detailed_summary=summary.detailed_summary,
            key_points=summary.key_points,
            decisions=decisions,
            action_items=action_items,
            risks=risks,
        )
        logger.info(
            "Pipeline complete for %s in %.1fs (transcribe %.1fs, analyze %.1fs): "
            "%d actions, %d decisions, %d risks.",
            meeting_id,
            analyzed_at - started,
            transcribed_at - started,
            analyzed_at - transcribed_at,
            len(action_items),
            len(decisions),
            len(risks),
        )
        return result
