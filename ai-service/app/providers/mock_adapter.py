"""Deterministic mock adapters.

These let the whole service run with **no API key** (the default,
`AI_PROVIDER=mock`). Output is realistic and stable so summaries/extractions
look believable in demos and are safe to assert against in tests.

The mock is a *narrative*, not a single fixed transcript: three sprint meetings
that reference each other. Week 1 makes promises; week 2 reports one done and
one slipped; week 3 cancels one and completes another. Distinct transcripts
matter because a single repeated one makes every meeting look identical, which
hides exactly the bugs a demo is meant to surface.

Script selection is deterministic and stateless: a digit in the filename picks
the week (`week2.wav`, `standup3.wav`), otherwise the audio bytes are hashed.
Naming uploads 1/2/3 therefore replays the intended story in order.
"""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass

from app.providers.ports import EmbeddingPort, LlmPort, TranscriptionPort
from app.schemas import (
    ActionItem,
    DraftEmailRequest,
    DraftEmailResponse,
    OutlineGroup,
    Segment,
    SummaryResponse,
    SummarySection,
    SummaryTemplate,
    TranscriptResponse,
)
from app.templates import resolve


@dataclass(frozen=True)
class MockScript:
    """One meeting in the mock narrative, with its expected extractions."""

    lines: tuple[tuple[str, str], ...]
    short_summary: str
    detailed_summary: str
    key_points: tuple[str, ...] = ()
    action_items: tuple[ActionItem, ...] = ()

    @property
    def transcript(self) -> str:
        return " ".join(text for _, text in self.lines)

    def segments(self) -> list[Segment]:
        """Evenly-paced segments at ~0.35s per word, deterministic."""
        segments: list[Segment] = []
        cursor = 0.0
        for speaker, text in self.lines:
            duration = round(max(2.0, len(text.split()) * 0.35), 2)
            segments.append(
                Segment(
                    start=round(cursor, 2),
                    end=round(cursor + duration, 2),
                    speaker=speaker,
                    text=text,
                )
            )
            cursor += duration
        return segments


# --------------------------------------------------------------------------- #
# Week 1 — promises made
# --------------------------------------------------------------------------- #
_WEEK_1 = MockScript(
    lines=(
        ("S1", "Alright everyone, let's kick off sprint planning for the meeting-brief feature."),
        ("S2", "Chaitanya will finish JWT validation on the Spring gateway by Friday."),
        ("S3", "I think we should store the meeting audio in S3 so uploads bypass the app servers."),
        ("S1", "Agreed, let's store the meeting audio in S3 via presigned URLs."),
        ("S2", "One concern: large audio files may slow down transcription and blow past our timeouts."),
        ("S3", "Priya will build the Kafka consumer for the transcription pipeline by next Wednesday."),
        ("S1", "We also decided to use OpenAI Whisper for transcription instead of the in-house model."),
        ("S2", "Risk: if the OpenAI API is down we have no fallback, processing could stall."),
        ("S3", "Marco should add a mock provider so the demo runs without any API keys."),
        ("S1", "Great. Let's regroup Thursday to review progress. Thanks everyone."),
    ),
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
    key_points=(
        "Store meeting audio in S3 via presigned URLs.",
        "Use OpenAI Whisper for transcription.",
        "Build a Kafka consumer for the transcription pipeline.",
        "Add a mock AI provider for keyless demos.",
        "Regroup Thursday to review progress.",
    ),
    action_items=(
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
    ),
)

# --------------------------------------------------------------------------- #
# Week 2 — one promise kept, one slipped
# --------------------------------------------------------------------------- #
_WEEK_2 = MockScript(
    lines=(
        ("S1", "Week two check-in on the meeting-brief feature."),
        ("S2", "JWT validation on the Spring gateway is done and merged, that one is closed out."),
        ("S1", "Nice work. Where did we land on the consumer?"),
        ("S3", "The Kafka consumer for the transcription pipeline has slipped and will not land until next week."),
        ("S1", "Noted. On transcription, we are moving off Whisper."),
        ("S2", "Agreed, use Deepgram for transcription instead of OpenAI Whisper."),
        ("S3", "Ana will benchmark Deepgram latency by Thursday."),
        ("S1", "Risk: swapping transcription vendors this late could destabilise the pipeline."),
        ("S2", "Let's confirm the storage approach again next week."),
    ),
    short_summary=(
        "Week two: JWT validation landed, the Kafka consumer slipped a week, and the "
        "team reversed its transcription decision from Whisper to Deepgram."
    ),
    detailed_summary=(
        "Week two check-in. JWT validation on the Spring gateway is complete and merged. "
        "The Kafka consumer for the transcription pipeline has slipped and is now expected "
        "next week. The team reversed an earlier decision and will use Deepgram for "
        "transcription instead of OpenAI Whisper; Ana will benchmark Deepgram latency by "
        "Thursday. The main risk raised was that switching transcription vendors this late "
        "could destabilise the pipeline."
    ),
    key_points=(
        "JWT validation is done and merged.",
        "The Kafka consumer slipped to next week.",
        "Transcription moves from Whisper to Deepgram.",
        "Benchmark Deepgram latency by Thursday.",
    ),
    action_items=(
        ActionItem(
            task_title="Benchmark Deepgram latency",
            owner_name="Ana",
            due_date="Thursday",
            priority="high",
            source_sentence="Ana will benchmark Deepgram latency by Thursday.",
        ),
    ),
)

# --------------------------------------------------------------------------- #
# Week 3 — one promise cancelled, one completed
# --------------------------------------------------------------------------- #
_WEEK_3 = MockScript(
    lines=(
        ("S1", "Week three. Quick pass over everything still outstanding."),
        ("S2", "We are dropping the mock provider work, it is no longer needed now that we have real keys."),
        ("S1", "Fine, cancel it. Where did the benchmark land?"),
        ("S3", "The Deepgram latency benchmark is completed and the results are in the doc."),
        ("S2", "On storage, confirmed: store the meeting audio in S3 using presigned URLs."),
        ("S1", "Good. Dev will write the migration guide by Monday."),
        ("S3", "Risk: the migration guide could be delayed if the vendor swap takes longer."),
    ),
    short_summary=(
        "Week three: the mock provider work was cancelled, the Deepgram benchmark "
        "completed, and the S3 storage decision was reaffirmed."
    ),
    detailed_summary=(
        "Week three review of outstanding items. The mock provider work was cancelled as "
        "it is no longer needed now that real API keys are available. The Deepgram latency "
        "benchmark is complete with results documented. The team reaffirmed its earlier "
        "decision to store meeting audio in S3 using presigned URLs. Dev will write the "
        "migration guide by Monday, with a risk that it is delayed if the vendor swap runs long."
    ),
    key_points=(
        "Mock provider work cancelled.",
        "Deepgram latency benchmark completed.",
        "S3 presigned-URL storage reaffirmed.",
        "Migration guide due Monday.",
    ),
    action_items=(
        ActionItem(
            task_title="Write the migration guide",
            owner_name="Dev",
            due_date="Monday",
            priority="medium",
            source_sentence="Dev will write the migration guide by Monday.",
        ),
    ),
)

SCRIPTS: tuple[MockScript, ...] = (_WEEK_1, _WEEK_2, _WEEK_3)

# Transcript -> script, so the LLM adapter returns extractions matching whatever
# transcript it is handed.
_BY_TRANSCRIPT = {s.transcript: s for s in SCRIPTS}


def select_script(filename: str | None, audio: bytes | None = None) -> MockScript:
    """Pick a script deterministically.

    A digit in the filename wins (`week2.wav` -> week 2), which is what makes the
    narrative replayable in order. Otherwise the audio bytes are hashed, so
    different uploads get different weeks while reprocessing the same audio is
    stable.
    """
    if filename:
        match = re.search(r"(\d+)", filename)
        if match:
            return SCRIPTS[(int(match.group(1)) - 1) % len(SCRIPTS)]
    if audio:
        digest = hashlib.md5(audio).digest()
        return SCRIPTS[int.from_bytes(digest[:4], "little") % len(SCRIPTS)]
    return SCRIPTS[0]


def script_for_transcript(transcript: str) -> MockScript:
    """Resolve extractions for a transcript, defaulting to week 1 for unknown text."""
    return _BY_TRANSCRIPT.get(transcript or "", SCRIPTS[0])


def _mock_sections(tpl: SummaryTemplate, script: MockScript) -> list[SummarySection]:
    """Fill a template's sections from the scripted brief.

    Only the three sections the script actually has material for are populated;
    the rest come back empty. That is deliberate — inventing plausible text for
    a "Budget" section the script knows nothing about would make the mock look
    like it understands the meeting, and would hide the empty-section case the
    UI has to handle anyway for a real meeting where the topic never came up.
    """
    sections: list[SummarySection] = []
    for spec in tpl.sections:
        section = SummarySection(key=spec.key, title=spec.title, kind=spec.kind)
        if spec.key == "overview":
            section.text = script.detailed_summary
        elif spec.key == "keyPoints":
            section.bullets = list(script.key_points)
        elif spec.key == "outline":
            section.groups = [
                OutlineGroup(heading="Discussion", bullets=list(script.key_points))
            ]
        sections.append(section)
    return sections


class MockTranscriptionAdapter(TranscriptionPort):
    """Returns one of the scripted sprint meetings."""

    async def transcribe(
        self,
        audio: bytes,
        filename: str,
        vocabulary: list[str] | None = None,
        language: str | None = None,
    ) -> TranscriptResponse:
        # Vocabulary and language are accepted and ignored: the scripts are
        # fixed English text, so there is nothing for a boosting hint to change
        # and nothing a language code could change it into.
        script = select_script(filename, audio)
        return TranscriptResponse(
            transcript=script.transcript,
            language="en",
            segments=script.segments(),
        )


class MockLlmAdapter(LlmPort):
    """Deterministic summary + extractions derived from the scripted meetings."""

    # `language` is accepted to satisfy the port but ignored: the scripts are
    # fixed English text, and pretending to translate them would make the mock
    # look like it does something it does not.
    async def summarize(
        self,
        transcript: str,
        language: str = "en",
        *,
        duration_seconds: float | None = None,
        speaker_count: int | None = None,
        template: SummaryTemplate | None = None,
    ) -> SummaryResponse:
        # The scripted brief is fixed, so the recording facts are accepted and
        # ignored: the mock exists to be deterministic, not descriptive.
        script = script_for_transcript(transcript)
        tpl = template or resolve(None)
        return SummaryResponse(
            short_summary=script.short_summary,
            detailed_summary=script.detailed_summary,
            key_points=list(script.key_points),
            sections=_mock_sections(tpl, script),
            template_slug=tpl.slug,
        )

    async def extract_action_items(
        self, transcript: str, language: str = "en"
    ) -> list[ActionItem]:
        return list(script_for_transcript(transcript).action_items)



    async def answer(
        self, question: str, context: list[str], *, exhaustive: bool = False
    ) -> str:
        # No real generation in mock mode — compose a grounded-looking answer
        # from the retrieved passages so the RAG UX is demoable without a key.
        if not context:
            return "I couldn't find anything about that in this meeting's transcript."
        joined = " ".join(context[:2]).strip()
        return f"Based on the meeting, {joined}"

    async def suggest_questions(self, material: str, *, workspace: bool = False) -> list[str]:
        # Nothing to generate from without a model. Empty rather than invented:
        # the caller falls back to its written-by-hand static prompts, which is
        # a better demo than three fabricated questions about a meeting the
        # mock has not read.
        return []

    async def translate(self, text: str, target_language: str) -> str:
        return f"[{target_language}] {text}"

    async def translate_lines(
        self, lines: list[str], target_language: str
    ) -> list[str]:
        # Same length in, same length out — the one property callers depend on,
        # so the mock has to honour it or it hides alignment bugs rather than
        # exposing them.
        return [f"[{target_language}] {line}" if line.strip() else line for line in lines]

    async def draft_followup_email(self, brief: DraftEmailRequest) -> DraftEmailResponse:
        """Assemble a recap from the brief's own words — no generation involved."""
        lines: list[str] = ["Hi all,", "", f"Thanks for the time on {brief.title}."]
        if brief.short_summary:
            lines += ["", brief.short_summary]
        if brief.action_items:
            lines += ["", "Next steps:"]
            lines += [f"  - {a}" for a in brief.action_items]
        if brief.key_points and not brief.action_items:
            lines += ["", "Key points:"]
            lines += [f"  - {k}" for k in brief.key_points]
        lines += ["", "Shout if I've missed or misremembered anything.", "", "Best,"]
        return DraftEmailResponse(subject=f"Recap: {brief.title}", body="\n".join(lines))


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
