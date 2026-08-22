"""Pipeline orchestration: transcribe -> (summarize | extract) in parallel.

The pipeline is provider-agnostic (it depends only on the ports) and is used by
both the synchronous HTTP endpoints and the async Kafka worker. Progress is
surfaced through an optional `progress_hook(topic, StatusEvent)` so the worker
can fan each stage out to Kafka + the Spring callback, while HTTP callers can
ignore it.

Latency note: summarization and action-item extraction take the same transcript
and are independent of one another, so they run concurrently — the analysis
stage costs the slower of the two rather than their sum. The
`transcript_hook` fires the moment the transcript exists, which lets the worker
start RAG indexing in the background while analysis is still running.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Awaitable, Callable

from app.insights import derive_insights
from app.language import annotate_segments
from app.quotes import anchor_outline, verify_quotes
from app.suggestions import meeting_material
from app.providers.ports import LlmPort, TranscriptionPort
from app.schemas import (
    DraftEmailRequest,
    DraftEmailResponse,
    MeetingBriefResult,
    Quotation,
    StatusEvent,
    SummaryResponse,
    SummaryTemplate,
    TranscriptResponse,
)
from app.templates import resolve

logger = logging.getLogger("ai-service.pipeline")

ProgressHook = Callable[[str, StatusEvent], Awaitable[None]]
# Fired as soon as the transcript is ready, before analysis starts.
TranscriptHook = Callable[[TranscriptResponse], Awaitable[None]]

# Kafka topics emitted per stage (api-contracts.md §6).
TOPIC_TRANSCRIPTION_STARTED = "transcription_started"
TOPIC_TRANSCRIPTION_COMPLETED = "transcription_completed"
TOPIC_SUMMARY_GENERATED = "summary_generated"
TOPIC_ACTION_ITEMS_EXTRACTED = "action_items_extracted"


def _duration_of(transcript: TranscriptResponse) -> float | None:
    """How long the recording ran, taken from the last segment that ends.

    `max` rather than the final segment's end: diarized segments are ordered by
    start, and two speakers overlapping at the close can leave the last one
    ending earlier than the one before it.
    """
    ends = [s.end for s in transcript.segments if s.end]
    return max(ends) if ends else None


def _speaker_count_of(transcript: TranscriptResponse) -> int | None:
    """Distinct voices, not turns. None when nothing was diarized."""
    speakers = {s.speaker for s in transcript.segments if s.speaker}
    return len(speakers) or None


class Pipeline:
    """Coordinates the transcription + LLM ports into a MeetingBriefResult."""

    def __init__(self, transcription: TranscriptionPort, llm: LlmPort) -> None:
        self._transcription = transcription
        self._llm = llm

    # --- individual stages (used directly by HTTP endpoints) ---------------- #
    async def transcribe(
        self,
        audio: bytes,
        filename: str,
        vocabulary: list[str] | None = None,
        language: str | None = None,
        *,
        request=None,
    ) -> TranscriptResponse:
        return await self._transcription.transcribe(
            audio, filename, vocabulary, language, request=request
        )

    async def summarize(
        self,
        transcript: str,
        *,
        duration_seconds: float | None = None,
        speaker_count: int | None = None,
        template: SummaryTemplate | None = None,
    ) -> SummaryResponse:
        return await self._llm.summarize(
            transcript,
            duration_seconds=duration_seconds,
            speaker_count=speaker_count,
            template=template,
        )

    async def extract_action_items(self, transcript: str):
        return await self._llm.extract_action_items(transcript)

    async def suggest_questions(
        self, material: str, *, workspace: bool = False, scope: str = "workspace"
    ) -> list[str]:
        return await self._llm.suggest_questions(
            material, workspace=workspace, scope=scope
        )

    async def translate(self, text: str, target_language: str) -> str:
        return await self._llm.translate(text, target_language)

    async def translate_lines(
        self, lines: list[str], target_language: str
    ) -> list[str]:
        return await self._llm.translate_lines(lines, target_language)

    async def draft_followup_email(self, brief: DraftEmailRequest) -> DraftEmailResponse:
        return await self._llm.draft_followup_email(brief)

    # --- full pipeline ------------------------------------------------------ #
    async def process(
        self,
        meeting_id: str,
        audio: bytes,
        filename: str,
        progress_hook: ProgressHook | None = None,
        transcript_hook: TranscriptHook | None = None,
        template_slug: str | None = None,
        vocabulary: list[str] | None = None,
        language: str | None = None,
        *,
        request=None,
    ) -> MeetingBriefResult:
        """Run the full pipeline, emitting stage events through the hook.

        `request` carries what the transcriber can use and the analysis cannot:
        the meeting's own context, how many speakers to expect, and a URL the
        provider may fetch the audio from. Optional, so the HTTP endpoints and
        every existing test call this exactly as they did.
        """

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
        transcript = await self._transcription.transcribe(
            audio, filename, vocabulary, language, request=request
        )
        # Providers report one language for the whole recording, which is wrong
        # for the meetings people actually notice: half in one language, half in
        # another. This marks the utterances that differ, leaving the rest None.
        annotate_segments(transcript.segments, transcript.language)
        transcribed_at = time.perf_counter()
        await emit(
            TOPIC_TRANSCRIPTION_COMPLETED, "TRANSCRIBING", 40, "Transcript ready; preparing summary..."
        )

        result = await self._analyze(meeting_id, transcript, emit, transcript_hook, template_slug)
        logger.info(
            "Pipeline complete for %s in %.1fs (transcribe %.1fs, analyze %.1fs).",
            meeting_id,
            time.perf_counter() - started,
            transcribed_at - started,
            time.perf_counter() - transcribed_at,
        )
        return result

    async def process_document(
        self,
        meeting_id: str,
        text: str,
        progress_hook: ProgressHook | None = None,
        transcript_hook: TranscriptHook | None = None,
        language: str = "en",
        template_slug: str | None = None,
    ) -> MeetingBriefResult:
        """Analyse an already-textual source (a PDF's text layer).

        Identical to `process` minus transcription: there is no audio, so there
        are no segments and no timeline. Downstream code already treats
        `segments` as optional, so a document brief simply renders without the
        player and without transcript deep-links.
        """

        async def emit(topic: str, status: str, progress: int, message: str) -> None:
            if progress_hook is None:
                return
            await progress_hook(
                topic,
                StatusEvent(meeting_id=meeting_id, status=status, progress=progress, message=message),
            )

        started = time.perf_counter()
        await emit(TOPIC_TRANSCRIPTION_COMPLETED, "TRANSCRIBING", 40, "Document read; preparing summary...")
        transcript = TranscriptResponse(transcript=text, language=language, segments=[])
        result = await self._analyze(meeting_id, transcript, emit, transcript_hook, template_slug)
        logger.info(
            "Document pipeline complete for %s in %.1fs (%d chars).",
            meeting_id,
            time.perf_counter() - started,
            len(text),
        )
        return result

    async def _analyze(
        self,
        meeting_id: str,
        transcript: TranscriptResponse,
        emit: Callable[[str, str, int, str], Awaitable[None]],
        transcript_hook: TranscriptHook | None,
        template_slug: str | None = None,
    ) -> MeetingBriefResult:
        """Shared tail of both pipelines: index, then extract everything at once."""
        # Let the caller start indexing now — it overlaps with the analysis below
        # so RAG chat is warm the moment the brief is ready.
        if transcript_hook is not None:
            await transcript_hook(transcript)

        # Summary and extraction take the same text and are independent, so
        # they run concurrently: cost is the slower call, not the sum.
        # The detected language rides along so the brief comes back in the
        # language the meeting was actually held in.
        await emit(TOPIC_SUMMARY_GENERATED, "SUMMARIZING", 60, "Summarizing and extracting insights...")
        text = transcript.transcript
        language = transcript.language or "en"
        # Resolved here rather than passed as a slug so an unknown one falls
        # back to General at the boundary, and everything below this line deals
        # in a template that certainly exists.
        template = resolve(template_slug)
        summary, action_items = await asyncio.gather(
            self._llm.summarize(
                text,
                language,
                duration_seconds=_duration_of(transcript),
                speaker_count=_speaker_count_of(transcript),
                template=template,
            ),
            self._llm.extract_action_items(text, language),
        )
        await emit(TOPIC_ACTION_ITEMS_EXTRACTED, "EXTRACTING", 95, "Insights extracted; finalizing brief...")

        logger.info(
            "Analysis for %s: %d action item(s).", meeting_id, len(action_items),
        )
        # Quotations claim to be exact, so the model's candidates are matched
        # back against the transcript and anything it could not have copied from
        # there is dropped. The raw section is removed rather than rendered
        # alongside: two versions of "the quotes", one checked and one not, is
        # exactly the ambiguity this is meant to remove.
        raw_quotes: list[str] = []
        kept_sections = []
        for section in summary.sections:
            if section.key == "quotes":
                raw_quotes = section.bullets
                continue
            kept_sections.append(section)
        quotes = [Quotation(**q) for q in verify_quotes(raw_quotes, transcript.segments)]

        # The outline headings are what the summary is navigated by, so each one
        # is anchored to the moment its topic began — by finding the line the
        # model says opened it, not by trusting a timestamp it never saw.
        anchor_outline(kept_sections, transcript.segments)

        # Decisions and risks are read back out of the sections just written,
        # not asked for again. A second extraction pass would produce a list
        # that disagrees with the summary next to it on the page.
        insights = derive_insights(kept_sections)

        # Starter questions for this meeting's chat, generated here so opening
        # the chat costs nothing: they are derived from a summary that will not
        # change, so generating per page view would buy an identical answer
        # every time. Never fatal — a brief without chips is a working brief.
        # The title is deliberately absent: it lives in Spring, not here, and
        # the pipeline has only ever seen the audio. The action items it does
        # have, and they are the half a summary cannot supply.
        suggestions = await self._suggest(
            meeting_id, summary.short_summary, kept_sections,
            action_items=[i.task_title for i in action_items],
        )

        return MeetingBriefResult(
            meeting_id=meeting_id,
            transcript=transcript.transcript,
            language=transcript.language,
            segments=transcript.segments,
            short_summary=summary.short_summary,
            detailed_summary=summary.detailed_summary,
            key_points=summary.key_points,
            sections=kept_sections,
            template_slug=summary.template_slug or template.slug,
            action_items=action_items,
            quotes=quotes,
            insights=insights,
            suggestions=suggestions,
        )

    async def _suggest(
        self,
        meeting_id: str,
        short_summary: str,
        sections: list,
        title: str = "",
        action_items: list[str] | None = None,
    ) -> list[str]:
        """Starter questions for this meeting, or none.

        Swallows failures on purpose. This is the last thing the pipeline does
        and the least important thing it produces — losing the chips costs a
        convenience, whereas letting the exception through would fail a meeting
        that has already been transcribed, summarized and had its action items
        extracted, and would re-run all of it on retry.
        """
        try:
            material = meeting_material(short_summary, sections, title, action_items)
            if not material.strip():
                return []
            return await self._llm.suggest_questions(material)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not suggest questions for %s: %s", meeting_id, exc)
            return []
