"""OpenAI adapters — Whisper transcription + chat-completions extraction.

Extraction uses JSON mode with prompts that instruct the model to extract only
what is explicitly present in the transcript and to quote the exact source
sentence. A light circuit-breaker (bounded retries + timeout + empty fallback)
wraps every call so a provider outage degrades to an empty structured result
rather than a 500.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
from typing import Any, Awaitable, Callable, TypeVar

from openai import AsyncOpenAI

from app.config import Settings
from app.providers.ports import EmbeddingPort, LlmPort, TranscriptionPort
from app.schemas import (
    ActionItem,
    CommitmentVerdict,
    Decision,
    DecisionRelation,
    Risk,
    Segment,
    SummaryResponse,
    TranscriptResponse,
)

logger = logging.getLogger("ai-service.openai")

T = TypeVar("T")


async def _with_retries(
    op: Callable[[], Awaitable[T]],
    *,
    attempts: int,
    fallback: T,
    label: str,
) -> T:
    """Run `op` with bounded retries + exponential backoff.

    On exhaustion, log and return `fallback` instead of raising — the
    circuit-breaker-ish behaviour required by the spec.
    """
    delay = 0.5
    for attempt in range(1, attempts + 1):
        try:
            return await op()
        except Exception as exc:  # noqa: BLE001 — deliberately broad; we degrade.
            logger.warning("OpenAI %s failed (attempt %d/%d): %s", label, attempt, attempts, exc)
            if attempt >= attempts:
                logger.error("OpenAI %s exhausted retries; returning fallback.", label)
                return fallback
            await asyncio.sleep(delay)
            delay *= 2
    return fallback


class OpenAiTranscriptionAdapter(TranscriptionPort):
    """Whisper transcription via the OpenAI SDK."""

    def __init__(self, settings: Settings, client: AsyncOpenAI | None = None) -> None:
        self._settings = settings
        self._client = client or AsyncOpenAI(
            api_key=settings.openai_api_key,
            timeout=settings.openai_timeout_seconds,
            max_retries=0,  # we manage retries ourselves
        )

    async def transcribe(self, audio: bytes, filename: str) -> TranscriptResponse:
        async def _op() -> TranscriptResponse:
            buffer = io.BytesIO(audio)
            buffer.name = filename or "audio.wav"
            resp: Any = await self._client.audio.transcriptions.create(
                model=self._settings.openai_transcribe_model,
                file=buffer,
                response_format="verbose_json",
            )
            text = getattr(resp, "text", "") or ""
            language = getattr(resp, "language", "en") or "en"
            segments: list[Segment] = []
            for seg in getattr(resp, "segments", None) or []:
                # verbose_json segments are objects or dicts depending on SDK version.
                get = seg.get if isinstance(seg, dict) else lambda k, d=None: getattr(seg, k, d)
                segments.append(
                    Segment(
                        start=float(get("start", 0.0) or 0.0),
                        end=float(get("end", 0.0) or 0.0),
                        speaker="S1",  # Whisper does not diarize; single speaker label.
                        text=str(get("text", "") or "").strip(),
                    )
                )
            return TranscriptResponse(transcript=text.strip(), language=language, segments=segments)

        return await _with_retries(
            _op,
            attempts=self._settings.openai_max_retries + 1,
            fallback=TranscriptResponse(transcript="", language="en", segments=[]),
            label="transcribe",
        )


_EXTRACTION_SYSTEM = (
    "You are a meticulous meeting-notes analyst. Extract ONLY information that is "
    "explicitly stated in the transcript. Do not infer, invent, or generalize. "
    "For every extracted item, include the exact verbatim source sentence from the "
    "transcript in `sourceSentence`. If nothing qualifies, return an empty list. "
    "Respond with a single JSON object only."
)


class OpenAiLlmAdapter(LlmPort):
    """Chat-completions summarization + JSON-mode structured extraction."""

    def __init__(self, settings: Settings, client: AsyncOpenAI | None = None) -> None:
        self._settings = settings
        self._client = client or AsyncOpenAI(
            api_key=settings.openai_api_key,
            timeout=settings.openai_timeout_seconds,
            max_retries=0,
        )

    async def _chat_json(self, system: str, user: str) -> dict[str, Any]:
        resp: Any = await self._client.chat.completions.create(
            model=self._settings.openai_chat_model,
            response_format={"type": "json_object"},
            temperature=0,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        content = resp.choices[0].message.content or "{}"
        return json.loads(content)

    async def summarize(self, transcript: str) -> SummaryResponse:
        async def _op() -> SummaryResponse:
            system = (
                "You summarize meeting transcripts. Return a JSON object with keys "
                "`shortSummary` (1-2 sentences), `detailedSummary` (one paragraph), and "
                "`keyPoints` (array of concise strings). Base everything strictly on the "
                "transcript."
            )
            data = await self._chat_json(system, f"Transcript:\n{transcript}")
            return SummaryResponse(
                short_summary=str(data.get("shortSummary", "")),
                detailed_summary=str(data.get("detailedSummary", "")),
                key_points=[str(k) for k in data.get("keyPoints", []) if k],
            )

        return await _with_retries(
            _op,
            attempts=self._settings.openai_max_retries + 1,
            fallback=SummaryResponse(short_summary="", detailed_summary="", key_points=[]),
            label="summarize",
        )

    async def extract_action_items(self, transcript: str) -> list[ActionItem]:
        async def _op() -> list[ActionItem]:
            user = (
                "Extract action items as JSON: "
                '{"actionItems":[{"taskTitle","ownerName","dueDate","priority"'
                '(high|medium|low),"sourceSentence"}]}. '
                "Use null for unknown owner/dueDate.\n\nTranscript:\n" + transcript
            )
            data = await self._chat_json(_EXTRACTION_SYSTEM, user)
            return [ActionItem.model_validate(x) for x in data.get("actionItems", [])]

        return await _with_retries(
            _op,
            attempts=self._settings.openai_max_retries + 1,
            fallback=[],
            label="extract_action_items",
        )

    async def extract_decisions(self, transcript: str) -> list[Decision]:
        async def _op() -> list[Decision]:
            user = (
                "Extract decisions as JSON: "
                '{"decisions":[{"decision","confidence"(high|medium|low),"sourceSentence"}]}.'
                "\n\nTranscript:\n" + transcript
            )
            data = await self._chat_json(_EXTRACTION_SYSTEM, user)
            return [Decision.model_validate(x) for x in data.get("decisions", [])]

        return await _with_retries(
            _op,
            attempts=self._settings.openai_max_retries + 1,
            fallback=[],
            label="extract_decisions",
        )

    async def extract_risks(self, transcript: str) -> list[Risk]:
        async def _op() -> list[Risk]:
            user = (
                "Extract risks as JSON: "
                '{"risks":[{"risk","severity"(high|medium|low),"sourceSentence"}]}.'
                "\n\nTranscript:\n" + transcript
            )
            data = await self._chat_json(_EXTRACTION_SYSTEM, user)
            return [Risk.model_validate(x) for x in data.get("risks", [])]

        return await _with_retries(
            _op,
            attempts=self._settings.openai_max_retries + 1,
            fallback=[],
            label="extract_risks",
        )

    async def answer(self, question: str, context: list[str]) -> str:
        async def _op() -> str:
            passages = "\n\n".join(f"[{i + 1}] {c}" for i, c in enumerate(context))
            system = (
                "You answer questions about a meeting using ONLY the provided transcript "
                "passages. If the answer is not in the passages, say you don't have that "
                "information. Be concise and specific."
            )
            resp: Any = await self._client.chat.completions.create(
                model=self._settings.openai_chat_model,
                temperature=0,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": f"Passages:\n{passages}\n\nQuestion: {question}"},
                ],
            )
            return (resp.choices[0].message.content or "").strip()

        return await _with_retries(
            _op,
            attempts=self._settings.openai_max_retries + 1,
            fallback="I couldn't reach the model to answer that right now.",
            label="answer",
        )

    async def translate(self, text: str, target_language: str) -> str:
        async def _op() -> str:
            resp: Any = await self._client.chat.completions.create(
                model=self._settings.openai_chat_model,
                temperature=0,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            f"Translate the user's text into {target_language}. "
                            "Preserve meaning, tone, names, and formatting. Output only the translation."
                        ),
                    },
                    {"role": "user", "content": text},
                ],
            )
            return (resp.choices[0].message.content or "").strip()

        return await _with_retries(
            _op,
            attempts=self._settings.openai_max_retries + 1,
            fallback=text,
            label="translate",
        )


    async def judge_commitment(
        self, commitment: str, owner: str | None, passages: list[str]
    ) -> CommitmentVerdict:
        async def _op() -> CommitmentVerdict:
            excerpts = "\n\n".join(f"[{i + 1}] {p}" for i, p in enumerate(passages))
            system = (
                "You audit whether a promise made in an earlier meeting was kept, based "
                "ONLY on excerpts from a LATER meeting. Choose exactly one outcome:\n"
                "  FULFILLED  — the excerpts state the work is done.\n"
                "  SLIPPED    — the excerpts state it is late, delayed, or rescheduled.\n"
                "  CANCELLED  — the excerpts state it is no longer being done.\n"
                "  RESTATED   — it is discussed again but with no resolution.\n"
                "  NO_EVIDENCE— the excerpts do not speak to this commitment at all.\n"
                "NO_EVIDENCE is the correct and common answer. Never infer progress from "
                "silence or from topic similarity alone. Quote verbatim in `quote`; use an "
                "empty string when the outcome is NO_EVIDENCE. Respond with a single JSON "
                'object: {"outcome","rationale","quote","confidence"(high|medium|low)}.'
            )
            user = (
                f"Commitment: {commitment}\n"
                f"Owner: {owner or 'unknown'}\n\n"
                f"Excerpts from the later meeting:\n{excerpts}"
            )
            data = await self._chat_json(system, user)
            return CommitmentVerdict.model_validate(data)

        return await _with_retries(
            _op,
            attempts=self._settings.openai_max_retries + 1,
            # Degrade to "we learned nothing" rather than a false verdict.
            fallback=CommitmentVerdict(outcome="NO_EVIDENCE"),
            label="judge_commitment",
        )

    async def compare_decisions(self, earlier: str, later: str) -> DecisionRelation:
        async def _op() -> DecisionRelation:
            system = (
                "You compare two decisions recorded from the same team at different times. "
                "Choose exactly one relation:\n"
                "  CONTRADICTS — they cannot both hold; the later reverses the earlier.\n"
                "  SUPERSEDES  — same subject, the later replaces the earlier without "
                "directly contradicting it.\n"
                "  REAFFIRMS   — the later restates or confirms the earlier.\n"
                "  UNRELATED   — they merely share vocabulary or subject matter.\n"
                "UNRELATED is the correct answer whenever the decisions do not actually "
                "interact. Be strict: a false contradiction is worse than a missed one. "
                'Respond with a single JSON object: {"relation","rationale"}.'
            )
            user = f"Earlier decision: {earlier}\n\nLater decision: {later}"
            data = await self._chat_json(system, user)
            return DecisionRelation.model_validate(data)

        return await _with_retries(
            _op,
            attempts=self._settings.openai_max_retries + 1,
            fallback=DecisionRelation(relation="UNRELATED"),
            label="compare_decisions",
        )


class OpenAiEmbeddingAdapter(EmbeddingPort):
    """text-embedding-3-small (1536-dim) via the OpenAI SDK."""

    def __init__(self, settings: Settings, client: AsyncOpenAI | None = None) -> None:
        self._settings = settings
        self._client = client or AsyncOpenAI(
            api_key=settings.openai_api_key,
            timeout=settings.openai_timeout_seconds,
            max_retries=0,
        )

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []

        async def _op() -> list[list[float]]:
            resp: Any = await self._client.embeddings.create(
                model=self._settings.openai_embed_model,
                input=texts,
            )
            return [list(d.embedding) for d in resp.data]

        # Fallback: zero-ish unit vectors so retrieval degrades rather than 500s.
        fallback = [[1.0] + [0.0] * (self._settings.embed_dim - 1) for _ in texts]
        return await _with_retries(
            _op,
            attempts=self._settings.openai_max_retries + 1,
            fallback=fallback,
            label="embed",
        )
