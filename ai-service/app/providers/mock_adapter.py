"""Deterministic mock adapters.

These let the whole service run with **no API key** (the default,
`AI_PROVIDER=mock`). Output is realistic and stable so summaries/extractions
look believable in demos and are safe to assert against in tests.
"""

from __future__ import annotations

import hashlib
import math
import re

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

# A believable ~10-line sprint-planning meeting.
_MOCK_LINES: list[tuple[str, str]] = [
    ("S1", "Alright everyone, let's kick off sprint planning for the meeting-brief feature."),
    ("S2", "Chaitanya will finish JWT validation on the Spring gateway by Friday."),
    ("S3", "I think we should store the meeting audio in S3 so uploads bypass the app servers."),
    ("S1", "Agreed, let's store the meeting audio in S3 via presigned URLs."),
    ("S2", "One concern: large audio files may slow down transcription and blow past our timeouts."),
    ("S3", "Priya will build the Kafka consumer for the transcription pipeline by next Wednesday."),
    ("S1", "We also decided to use Whisper for transcription instead of the in-house model."),
    ("S2", "Risk: if the OpenAI API is down we have no fallback, processing could stall."),
    ("S3", "Marco should add a mock provider so the demo runs without any API keys."),
    ("S1", "Great. Let's regroup Thursday to review progress. Thanks everyone."),
]

_MOCK_TRANSCRIPT = " ".join(text for _, text in _MOCK_LINES)


def _build_segments() -> list[Segment]:
    segments: list[Segment] = []
    cursor = 0.0
    for speaker, text in _MOCK_LINES:
        # ~0.35s per word, deterministic.
        duration = round(max(2.0, len(text.split()) * 0.35), 2)
        segments.append(
            Segment(start=round(cursor, 2), end=round(cursor + duration, 2), speaker=speaker, text=text)
        )
        cursor += duration
    return segments


class MockTranscriptionAdapter(TranscriptionPort):
    """Returns a fixed, realistic sprint-meeting transcript."""

    async def transcribe(self, audio: bytes, filename: str) -> TranscriptResponse:
        return TranscriptResponse(
            transcript=_MOCK_TRANSCRIPT,
            language="en",
            segments=_build_segments(),
        )


class MockLlmAdapter(LlmPort):
    """Deterministic summary + extractions derived from the mock transcript."""

    async def summarize(self, transcript: str) -> SummaryResponse:
        return SummaryResponse(
            short_summary=(
                "Sprint planning for the meeting-brief feature: the team agreed to store "
                "audio in S3, use Whisper for transcription, and assigned follow-up tasks."
            ),
            detailed_summary=(
                "The team held sprint planning for the meeting-brief feature. Chaitanya took "
                "ownership of JWT validation on the Spring gateway (due Friday). The group "
                "decided to store meeting audio in S3 using presigned uploads so large media "
                "bypasses the application servers, and to use OpenAI Whisper for transcription "
                "rather than an in-house model. Priya will build the Kafka consumer for the "
                "transcription pipeline by next Wednesday, and Marco will add a mock provider so "
                "demos run without API keys. Two risks were raised: large audio files may slow "
                "transcription and exceed timeouts, and there is no fallback if the OpenAI API is "
                "unavailable. The team will regroup Thursday to review progress."
            ),
            key_points=[
                "Store meeting audio in S3 via presigned URLs.",
                "Use OpenAI Whisper for transcription.",
                "Build a Kafka consumer for the transcription pipeline.",
                "Add a mock AI provider for keyless demos.",
                "Regroup Thursday to review progress.",
            ],
        )

    async def extract_action_items(self, transcript: str) -> list[ActionItem]:
        return [
            ActionItem(
                task_title="Finish JWT validation on the Spring gateway",
                owner_name="Chaitanya",
                due_date="Friday",
                priority="high",
                source_sentence="Chaitanya will finish JWT validation on the Spring gateway by Friday.",
            ),
            ActionItem(
                task_title="Build the Kafka consumer for the transcription pipeline",
                owner_name="Priya",
                due_date="next Wednesday",
                priority="medium",
                source_sentence="Priya will build the Kafka consumer for the transcription pipeline by next Wednesday.",
            ),
            ActionItem(
                task_title="Add a mock AI provider for keyless demos",
                owner_name="Marco",
                due_date=None,
                priority="medium",
                source_sentence="Marco should add a mock provider so the demo runs without any API keys.",
            ),
        ]

    async def extract_decisions(self, transcript: str) -> list[Decision]:
        return [
            Decision(
                decision="Store the meeting audio in S3 using presigned URLs.",
                confidence="high",
                source_sentence="Agreed, let's store the meeting audio in S3 via presigned URLs.",
            ),
            Decision(
                decision="Use OpenAI Whisper for transcription instead of the in-house model.",
                confidence="high",
                source_sentence="We also decided to use Whisper for transcription instead of the in-house model.",
            ),
        ]

    async def extract_risks(self, transcript: str) -> list[Risk]:
        return [
            Risk(
                risk="Large audio files may slow down transcription and exceed timeouts.",
                severity="medium",
                source_sentence="One concern: large audio files may slow down transcription and blow past our timeouts.",
            ),
            Risk(
                risk="No fallback if the OpenAI API is unavailable; processing could stall.",
                severity="high",
                source_sentence="Risk: if the OpenAI API is down we have no fallback, processing could stall.",
            ),
        ]

    async def answer(self, question: str, context: list[str]) -> str:
        # No real generation in mock mode — compose a grounded-looking answer
        # from the retrieved passages so the RAG UX is demoable without a key.
        if not context:
            return "I couldn't find anything about that in this meeting's transcript."
        joined = " ".join(context[:2]).strip()
        return f"Based on the meeting, {joined}"

    async def translate(self, text: str, target_language: str) -> str:
        return f"[{target_language}] {text}"

    async def judge_commitment(
        self, commitment: str, owner: str | None, passages: list[str]
    ) -> CommitmentVerdict:
        """Keyword heuristic standing in for a real judgement.

        Deliberately conservative: it only reports an outcome when a passage
        both overlaps the commitment's vocabulary AND contains a completion or
        delay cue, so keyless demos don't fabricate a ledger full of verdicts.
        """
        if not passages:
            return CommitmentVerdict(outcome="NO_EVIDENCE")

        keywords = {w for w in re.findall(r"[a-z]{4,}", commitment.lower())}
        for passage in passages:
            lowered = passage.lower()
            overlap = sum(1 for k in keywords if k in lowered)
            if overlap < 2:
                continue
            if any(c in lowered for c in ("done", "finished", "shipped", "completed", "merged")):
                outcome, reason = "FULFILLED", "A later passage reports this as completed."
            elif any(c in lowered for c in ("slip", "delay", "pushed", "behind", "next week")):
                outcome, reason = "SLIPPED", "A later passage reports this as delayed."
            elif any(c in lowered for c in ("drop", "cancel", "no longer", "scrapped")):
                outcome, reason = "CANCELLED", "A later passage reports this as cancelled."
            else:
                outcome, reason = "RESTATED", "The commitment came up again without a resolution."
            return CommitmentVerdict(
                outcome=outcome,
                rationale=reason,
                quote=passage[:280],
                confidence="medium",
            )
        return CommitmentVerdict(outcome="NO_EVIDENCE")

    async def compare_decisions(self, earlier: str, later: str) -> DecisionRelation:
        """Lexical stand-in: negation cues flip a near-duplicate into a conflict."""
        a, b = earlier.lower(), later.lower()
        if a.strip() == b.strip():
            return DecisionRelation(
                relation="REAFFIRMS", rationale="The later decision restates the earlier one."
            )
        negations = ("instead", "no longer", "not ", "rather than", "revert", "switch")
        if any(n in b for n in negations):
            return DecisionRelation(
                relation="CONTRADICTS",
                rationale="The later decision reverses the earlier one.",
            )
        # Strong vocabulary overlap on the same subject reads as a replacement.
        words_a = {w for w in re.findall(r"[a-z]{4,}", a)}
        words_b = {w for w in re.findall(r"[a-z]{4,}", b)}
        if words_a and len(words_a & words_b) / len(words_a) > 0.5:
            return DecisionRelation(
                relation="SUPERSEDES",
                rationale="The later decision revisits the same subject with a new outcome.",
            )
        return DecisionRelation(relation="UNRELATED")


class MockEmbeddingAdapter(EmbeddingPort):
    """Deterministic hashing-bag-of-words embedder.

    Not semantic, but lexical overlap produces meaningful cosine similarity —
    so keyword-matching questions retrieve the right chunks in keyless demos.
    """

    def __init__(self, dim: int = 1536) -> None:
        self._dim = dim

    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._embed_one(t) for t in texts]

    def _embed_one(self, text: str) -> list[float]:
        vec = [0.0] * self._dim
        for token in re.findall(r"[a-z0-9]+", text.lower()):
            if len(token) < 2:
                continue
            # Stable hash (NOT builtin hash(), which is per-process randomized —
            # persisted chunk vectors must match query vectors after a restart).
            digest = hashlib.md5(token.encode("utf-8")).digest()
            bucket = int.from_bytes(digest[:4], "little") % self._dim
            vec[bucket] += 1.0
        norm = math.sqrt(sum(v * v for v in vec))
        if norm == 0.0:
            # Non-zero unit vector so cosine distance is always defined.
            vec[0] = 1.0
            return vec
        return [v / norm for v in vec]
