"""Summary templates: the shape contract, and the wiring that carries it.

A template decides what a meeting's notes contain, so the risks here are about
a choice quietly not being honoured rather than about a crash:

* a template that drops Overview or Outline would make switching to it lose the
  notes the user was relying on
* a slug that fails to reach the summarizer produces General notes under a
  heading that claims otherwise, which is worse than an error because nothing
  tells the reader
* sections that never reach the brief leave Spring persisting an empty list, so
  the meeting renders in the old flat shape and the template looks ignored
"""

from __future__ import annotations

import asyncio

import pytest

from app.pipeline import Pipeline
from app.schemas import (
    MeetingUploadedEvent,
    SummarizeRequest,
    SummaryResponse,
    SummarySection,
    TranscriptResponse,
)
from app.templates import BUILT_IN, BY_SLUG, resolve


# --- the shape every template must keep ----------------------------------- #
@pytest.mark.parametrize("tpl", BUILT_IN, ids=[t.slug for t in BUILT_IN])
def test_every_template_opens_with_overview_and_closes_with_outline(tpl):
    """The two ends are fixed so switching template never loses the summary.

    Only the middle varies. If a template could omit Overview, picking it would
    take away the paragraph someone had been reading the meeting through.
    """
    assert tpl.sections[0].key == "overview"
    assert tpl.sections[-1].key == "outline"


@pytest.mark.parametrize("tpl", BUILT_IN, ids=[t.slug for t in BUILT_IN])
def test_every_section_carries_an_instruction(tpl):
    """A section with no instruction is a heading the model must guess at."""
    for section in tpl.sections:
        assert section.instruction.strip(), f"{tpl.slug}/{section.key}"
        assert section.title.strip()


@pytest.mark.parametrize("tpl", BUILT_IN, ids=[t.slug for t in BUILT_IN])
def test_section_keys_are_unique_within_a_template(tpl):
    """Keys address sections in the reply, so a duplicate silently loses one."""
    keys = [s.key for s in tpl.sections]
    assert len(keys) == len(set(keys))


def test_slugs_are_unique():
    assert len(BY_SLUG) == len(BUILT_IN)


def test_unknown_slug_falls_back_to_general():
    """A template removed after a meeting was summarized must still produce notes."""
    assert resolve("a-template-that-was-deleted").slug == "general"
    assert resolve(None).slug == "general"
    assert resolve("").slug == "general"


# --- the wiring ------------------------------------------------------------ #
class _StubTranscription:
    async def transcribe(
        self, audio: bytes, filename: str, vocabulary: list[str] | None = None
    ) -> TranscriptResponse:
        return TranscriptResponse(transcript="Hello.", language="en", segments=[])


class _RecordingLlm:
    """Captures the template it was handed, and returns one section."""

    def __init__(self) -> None:
        self.template = None

    async def summarize(self, transcript, language="en", *, template=None, **facts):
        self.template = template
        return SummaryResponse(
            short_summary="s",
            detailed_summary="d",
            key_points=[],
            sections=[SummarySection(key="overview", title="Overview", kind="prose", text="d")],
            template_slug=template.slug if template else None,
        )

    async def extract_action_items(self, transcript, language="en"):
        return []

    async def extract_decisions(self, transcript, language="en"):
        return []

    async def extract_risks(self, transcript, language="en"):
        return []


def _run(slug):
    llm = _RecordingLlm()
    pipeline = Pipeline(_StubTranscription(), llm)
    result = asyncio.run(pipeline.process("mtg_1", b"", "a.wav", template_slug=slug))
    return llm, result


def test_the_chosen_template_reaches_the_summarizer():
    llm, _ = _run("sales-bant")
    assert llm.template is not None
    assert llm.template.slug == "sales-bant"
    # Resolved, not passed as a bare slug: the summarizer needs the wording.
    assert any(s.key == "budget" for s in llm.template.sections)


def test_an_unknown_slug_still_summarizes():
    llm, result = _run("no-such-template")
    assert llm.template.slug == "general"
    assert result.template_slug == "general"


def test_sections_reach_the_brief_spring_persists():
    """Without this the meeting renders in the old flat shape and looks broken."""
    _, result = _run("general")
    assert [s.key for s in result.sections] == ["overview"]
    assert result.template_slug == "general"


def test_document_pipeline_honours_the_template_too():
    """A PDF skips transcription, so it is a separate path that can drift."""
    llm = _RecordingLlm()
    pipeline = Pipeline(_StubTranscription(), llm)
    result = asyncio.run(
        pipeline.process_document("mtg_1", "Some text.", template_slug="one-on-one")
    )
    assert llm.template.slug == "one-on-one"
    assert result.template_slug == "one-on-one"


# --- the event and the request --------------------------------------------- #
def test_an_event_without_a_template_still_validates():
    """Jobs enqueued before this field existed must not become poison messages."""
    event = MeetingUploadedEvent.model_validate({"meetingId": "mtg_1"})
    assert event.summary_template is None


def test_the_event_carries_the_choice():
    event = MeetingUploadedEvent.model_validate(
        {"meetingId": "mtg_1", "summaryTemplate": "team-standup"}
    )
    assert event.summary_template == "team-standup"


def test_summarize_request_accepts_a_slug():
    """Spring sends only the slug, so the instructions never leave this service."""
    req = SummarizeRequest.model_validate({"transcript": "x", "templateSlug": "sales-discovery"})
    assert req.template_slug == "sales-discovery"
    assert req.template is None
