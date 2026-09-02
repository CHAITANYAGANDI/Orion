"""Pipeline orchestration: transcribe -> (summarize | extract) in parallel.

The pipeline is provider-agnostic (it depends only on the ports) and is used by
both the synchronous HTTP endpoints and the async Kafka worker. Progress is
surfaced through an optional `progress_hook(StatusEvent)` so the worker
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
from app import naming
from app.quotes import anchor_outline, verify_quotes
from app.suggestions import meeting_material
from app.providers.ports import LlmPort, TranscriptionPort
from app.reattribute import flatten, reattribute
from app.reconcile import assign
from app.rediarize import SpeakerRefiner
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

ProgressHook = Callable[[StatusEvent], Awaitable[None]]
# Fired as soon as the transcript is ready, before analysis starts.
TranscriptHook = Callable[[TranscriptResponse], Awaitable[None]]

# The percentage each stage reports, and one half of a contract.
#
# The browser cannot only listen to these. A dropped WebSocket would leave the
# bar frozen over a meeting that finished minutes ago, so it also polls the
# meeting's *status* and converts that to a percentage itself. Two sources, one
# number — which means the two ladders have to be the same ladder.
#
# They were not. This module used to send 10/40/60/95 while the browser's status
# table read 25 for QUEUED, so the first event of every meeting moved the number
# from 25% down to 10%: a bar that visibly went backwards the moment work
# actually started.
#
# So each value below is the *floor* of its status, and the browser's table
# holds the same floors. A stage may report a higher number as it progresses
# (TRANSCRIBING does, twice) and a poll arriving in between simply repeats the
# floor, which is why the browser also refuses to let the number fall. Change a
# number here and change it in frontend/lib/format.ts.
PROGRESS_TRANSCRIBING = 5
PROGRESS_TRANSCRIBED = 55
PROGRESS_SUMMARIZING = 60
PROGRESS_EXTRACTING = 90
PROGRESS_DONE = 100


def _joined(segments) -> str:
    """The flat transcript, rebuilt from the turns.

    Same shape the adapters produce, and deliberately so: the speaker prefix is
    read by the summarizer, and a transcript whose prefixes disagree with the
    segments beside it is worse than either version alone.
    """
    return "\n".join(
        f"{s.speaker}: {s.text}" if s.speaker else s.text
        for s in segments
        if s.text and s.text.strip()
    ).strip()


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

    def __init__(self, transcription: TranscriptionPort, llm: LlmPort,
                 refiner: "SpeakerRefiner | None" = None,
                 diarizer=None,
                 name_speakers: bool = True) -> None:
        self._transcription = transcription
        self._refiner = refiner
        #: Whether to read speakers' names out of what they said to each other.
        #: A plain flag rather than a Settings object, so this class still
        #: depends on nothing but its ports; `app.main` supplies the setting.
        self._name_speakers = name_speakers
        #: An acoustic DiarizationPort allowed to overrule the provider's
        #: speaker labels outright, or None to keep them.
        #:
        #: None everywhere today: the only implementation was pyannote, removed
        #: after measurement rather than neglect (docs/diarization.md §12). The
        #: reconciliation this feeds — app/reconcile.py and app/reattribute.py —
        #: is kept and still tested, so the port is the whole of what a future
        #: diarizer would have to supply.
        self._diarizer = diarizer
        self._llm = llm

    async def _read_names(self, meeting_id: str, transcript: TranscriptResponse) -> None:
        """Give the speakers the names the conversation gave them.

        People say who they are — "I'm Michael" — and say who each other are —
        "how are you, Michael?" — and until now Reverie printed *Speaker 1* over
        the top of both. This reads them, and the direction is the whole
        difficulty: a name said in a turn almost never belongs to the person
        saying it. `app.naming` holds the rules and checks every claim against
        the turns; nothing here decides anything.

        Runs before analysis rather than after, so the names are in the flat
        transcript the summarizer reads, in the passages chat retrieves, and in
        the export. Doing it afterwards would mean a brief that says *Speaker 2*
        beside a transcript that says Michael, and a re-index to repair.

        Never raises and never partly applies. A meeting whose speakers cannot
        be named is a meeting with Speaker 1 and Speaker 2 in it, which is where
        it started and a perfectly good place to stay.
        """
        if not self._name_speakers or not transcript.segments:
            return
        labels = naming.open_labels(transcript.segments)
        if not labels:
            # Everybody is already named, or nobody was attributed at all.
            return
        try:
            claims = await self._llm.identify_speaker_names(
                naming.dialogue(transcript.segments), labels, transcript.language or "en",
            )
        except Exception:  # noqa: BLE001 - a nameless transcript is a working one
            logger.warning("Speaker naming unavailable for %s; keeping the numbers.", meeting_id)
            return

        applied = naming.apply(transcript.segments, naming.resolve(claims, transcript.segments))
        if not applied:
            # Much the most common outcome, and not a failure: most meetings
            # never say anybody's name out loud.
            return
        # The flat text carries the speaker prefix and is what the summarizer
        # reads, so it has to be rebuilt rather than left describing the numbers.
        transcript.transcript = _joined(transcript.segments) or transcript.transcript
        # Counts, not names. A speaker's name is transcript content, and the
        # logs are the one place it would end up outside the user's own account.
        logger.info(
            "Named %d of %d speaker(s) in %s from the dialogue.",
            len(applied), len(labels), meeting_id,
        )

    async def _reattribute(self, segments, audio, audio_loader):
        """Replace the provider's speakers with the diarizer's, or keep them.

        Never raises and never returns fewer words than it was given. Every
        failure — no audio, no weights, a model that throws, a word count that
        does not line up — returns the input untouched, because a meeting with a
        good transcript and a broken diarizer still has a good transcript.
        """
        clip = audio
        if not clip and audio_loader is not None:
            try:
                clip = await audio_loader()
            except Exception:  # noqa: BLE001 - unreadable audio is "no audio"
                clip = None
        if not clip:
            return segments

        timeline = await self._diarizer.diarize(clip)
        if timeline.unavailable:
            logger.info("diarizer unavailable (%s); keeping the provider's speakers.",
                        timeline.unavailable)
            return segments

        # Flattened by reattribute's own helper, so the verdicts come back
        # positionally aligned with the words they were made about.
        words = [(w.text, w.start, w.end, w.speaker) for w in flatten(segments)]
        result = assign(words, timeline)
        # Counts only. Never the words themselves, in any deployment (§12).
        logger.info("diarization reconciled: %s", result.telemetry())
        return reattribute(segments, result)

    # --- individual stages (used directly by HTTP endpoints) ---------------- #
    async def transcribe(
        self,
        audio: bytes,
        filename: str,
        language: str | None = None,
        *,
        request=None,
    ) -> TranscriptResponse:
        return await self._transcription.transcribe(
            audio, filename, language, request=request
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
        language: str | None = None,
        *,
        request=None,
        audio_loader=None,
    ) -> MeetingBriefResult:
        """Run the full pipeline, emitting stage events through the hook.

        `request` carries what the transcriber can use and the analysis cannot:
        the meeting's own context, how many speakers to expect, and a URL the
        provider may fetch the audio from. Optional, so the HTTP endpoints and
        every existing test call this exactly as they did.

        `audio_loader` returns the recording's bytes, and is separate from
        `audio` because the two are usually not both wanted: when the provider
        fetches the file itself, `audio` is empty on purpose and nothing here
        has ever needed it. Speaker refinement does need it, so it is a callable
        — nothing is downloaded unless there is a turn worth examining.
        """

        async def emit(status: str, progress: int, message: str) -> None:
            if progress_hook is None:
                return
            await progress_hook(
                StatusEvent(meeting_id=meeting_id, status=status, progress=progress, message=message),
            )

        started = time.perf_counter()

        # 1) Transcription
        await emit(
            "TRANSCRIBING", PROGRESS_TRANSCRIBING,
            "Generating transcript from audio...",
        )
        transcript = await self._transcription.transcribe(
            audio, filename, language, request=request
        )

        # Check the provider's turn boundaries against the audio before anything
        # downstream reads them. A missed boundary is not cosmetic: the summary,
        # the retrieval passages and the exports all carry the speaker prefix,
        # so two people merged into one label propagate as a quotation from
        # somebody who never said it. See app/rediarize.py.
        #
        # Before `annotate_segments` because a split creates segments, and every
        # one of them needs its language decided.
        if self._refiner is not None:
            loader = audio_loader
            if loader is None and audio:
                async def loader():  # noqa: E306 - the bytes are already here
                    return audio
            transcript.segments, refinement = await self._refiner.refine(
                list(transcript.segments), loader
            )
            if refinement.changed:
                # The flat text carries the speaker prefixes and is what the
                # summarizer reads, so it has to be rebuilt from the corrected
                # turns rather than left describing the old ones.
                transcript.transcript = _joined(transcript.segments) or transcript.transcript

        # A second opinion from an acoustic diarizer, where one is configured.
        # This does not adjust the provider's boundaries the way the refiner
        # above does — it replaces them, attributing every word to whichever
        # speaker the diarizer heard holding most of it. Off unless a
        # deployment asked for it; the benchmark behind that default is in
        # docs/diarization.md.
        if self._diarizer is not None:
            transcript.segments = await self._reattribute(
                transcript.segments, audio, audio_loader
            )
            transcript.transcript = _joined(transcript.segments) or transcript.transcript

        # Providers report one language for the whole recording, which is wrong
        # for the meetings people actually notice: half in one language, half in
        # another. This marks the utterances that differ, leaving the rest None.
        #
        # After reattribution, deliberately: a split creates segments and every
        # one of them needs its language decided.
        annotate_segments(transcript.segments, transcript.language)

        # Who these people are, according to the people themselves. Last of the
        # transcript stage and before anything reads the text, because every
        # artefact below this line carries the speaker prefix: the summary, the
        # retrieval passages, the quotations and the export.
        await self._read_names(meeting_id, transcript)

        transcribed_at = time.perf_counter()
        # Still TRANSCRIBING, deliberately: the status has not moved on, but the
        # long part of it is over. This is the one place a stage reports above
        # its own floor, and the reason the browser clamps rather than trusts
        # whichever of the socket and the poll spoke last.
        await emit(
            "TRANSCRIBING", PROGRESS_TRANSCRIBED,
            "Transcript ready; preparing summary...",
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

        async def emit(status: str, progress: int, message: str) -> None:
            if progress_hook is None:
                return
            await progress_hook(
                StatusEvent(meeting_id=meeting_id, status=status, progress=progress, message=message),
            )

        started = time.perf_counter()
        await emit(
            "TRANSCRIBING", PROGRESS_TRANSCRIBED,
            "Document read; preparing summary...",
        )
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
        await emit(
            "SUMMARIZING", PROGRESS_SUMMARIZING,
            "Summarizing and extracting insights...",
        )
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
        await emit(
            "EXTRACTING", PROGRESS_EXTRACTING,
            "Insights extracted; finalizing brief...",
        )

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
        #
        # The title used to be left out of the material on the grounds that it
        # lived in Spring and the pipeline had only ever seen the audio. Half of
        # that is no longer true: the summarizer now writes one from the same
        # transcript, so the chips can use the meeting's own subject.
        suggestions = await self._suggest(
            meeting_id, summary.short_summary, kept_sections,
            title=summary.title or "",
            action_items=[i.task_title for i in action_items],
        )

        return MeetingBriefResult(
            meeting_id=meeting_id,
            # Read off the transcript, and only ever applied by Spring to a
            # meeting still carrying the recorder's timestamp. None when there
            # was nothing worth naming, which leaves that timestamp alone.
            title=summary.title,
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
