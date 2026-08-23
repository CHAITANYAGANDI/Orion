"""Choosing what a suggester gets to look at.

The prompt lives in the adapter; this is the other half, and it is where the
quality actually comes from. Two decisions matter and both fail silently:

* send the outline and the questions come back as "what did Speaker 2 say at
  the start?" — the outline is a chronological walkthrough, so it is mostly
  narrative and it is the largest section by far
* send an unbounded workspace and a user with a thousand meetings gets an
  unbounded prompt, per request

The pipeline wiring is covered too, because the generation call is deliberately
wrapped in a swallow-everything handler — chips are not worth failing a brief
over — and that handler will just as happily hide a method that was never wired
up at all.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

from app.pipeline import Pipeline
from app.schemas import SummaryResponse, SummarySection, TranscriptResponse
from app.suggestions import MAX_MEETINGS, MAX_OPEN_ITEMS, meeting_material, workspace_material


def _section(key, title, kind="bullets", text="", bullets=()):
    return SummarySection(key=key, title=title, kind=kind, text=text, bullets=list(bullets))


# --- one meeting ------------------------------------------------------------ #
def test_the_summary_and_its_headings_are_included():
    """The headings are half the signal.

    A "Blockers" heading with three bullets under it says there is something
    specific to ask about; the same words flattened into prose read as more
    narrative.
    """
    material = meeting_material(
        "The team moved the launch to April.",
        [
            _section("decisions", "Decisions", bullets=["Move the launch to April."]),
            _section("blockers", "Blockers", bullets=["Waiting on the vendor."]),
        ],
        title="Launch sync",
    )
    assert "Launch sync" in material
    assert "The team moved the launch to April." in material
    assert "## Decisions" in material
    assert "- Move the launch to April." in material
    assert "## Blockers" in material


def test_the_outline_is_left_out():
    """It is the walkthrough: largest section, least useful here.

    Questions drawn from it come out as "what did Speaker 2 say at the start?",
    which is answerable and worthless.
    """
    material = meeting_material(
        "Summary.",
        [
            _section("decisions", "Decisions", bullets=["A real decision."]),
            SummarySection(
                key="outline",
                title="Outline",
                kind="outline",
                groups=[{"heading": "Opening", "bullets": ["Speaker 1 says hello."]}],
            ),
        ],
    )
    assert "A real decision." in material
    assert "Outline" not in material
    assert "Speaker 1 says hello." not in material


def test_quotations_are_left_out():
    """A quote is an answer, not a question. Suggesting one back produces
    "what did they mean by X?" about a line already reproduced on the page."""
    material = meeting_material(
        "Summary.",
        [_section("quotes", "Key quotations", bullets=["we are not shipping on the 7th"])],
    )
    assert "not shipping" not in material


def test_prose_sections_carry_their_text():
    material = meeting_material(
        "", [_section("purpose", "Purpose", kind="prose", text="To settle the vendor question.")]
    )
    assert "To settle the vendor question." in material


def test_an_empty_section_contributes_no_heading():
    """A bare "## Risks" with nothing under it invites a question about risks
    that were never raised."""
    material = meeting_material("Summary.", [_section("risks", "Risks", bullets=[])])
    assert "Risks" not in material


def test_bullets_are_capped_per_section():
    material = meeting_material(
        "", [_section("keyPoints", "Key points", bullets=[f"Point {i}" for i in range(30)])]
    )
    assert "Point 0" in material
    assert "Point 29" not in material


def test_nothing_to_say_produces_nothing():
    """The signal to skip the model call rather than ask for questions about
    an empty summary."""
    assert meeting_material("", []) == ""


# --- the workspace ---------------------------------------------------------- #
def _meetings(n):
    return [
        (f"Meeting {i}", datetime(2026, 8, 1, tzinfo=timezone.utc), f"Summary {i}")
        for i in range(n)
    ]


def test_meetings_carry_their_title_date_and_summary():
    material = workspace_material(
        [("Acme kickoff", datetime(2026, 8, 10, tzinfo=timezone.utc), "We agreed terms.")]
    )
    assert "Acme kickoff" in material
    # The date is what lets a suggestion say "recent" and mean it.
    assert "2026-08-10" in material
    assert "We agreed terms." in material


def test_outstanding_items_are_included():
    """The most useful cross-meeting question is usually about a promise, and
    that is the one thing summaries cannot supply — they record what was said,
    never what happened afterwards."""
    material = workspace_material(
        _meetings(1), [("Send the pricing deck", "Acme kickoff")]
    )
    assert "Outstanding action items" in material
    assert "Send the pricing deck" in material
    assert "from: Acme kickoff" in material


def test_the_meeting_list_is_capped():
    material = workspace_material(_meetings(MAX_MEETINGS + 10))
    assert f"Meeting {MAX_MEETINGS - 1}" in material
    assert f"Meeting {MAX_MEETINGS + 5}" not in material


def test_the_item_list_is_capped():
    items = [(f"Item {i}", "A meeting") for i in range(MAX_OPEN_ITEMS + 10)]
    material = workspace_material(_meetings(1), items)
    assert f"Item {MAX_OPEN_ITEMS - 1}" in material
    assert f"Item {MAX_OPEN_ITEMS + 5}" not in material


def test_a_long_summary_is_truncated_not_dropped():
    material = workspace_material(
        [("A meeting", None, "x" * 5000)]
    )
    assert "A meeting" in material
    assert len(material) < 5000


def test_a_missing_date_does_not_break_the_line():
    material = workspace_material([("A meeting", None, "Summary.")])
    assert "- A meeting" in material


def test_an_empty_archive_produces_nothing():
    """Skip the model call rather than ask it to invent questions about
    an archive with nothing in it."""
    assert workspace_material([], []) == ""
    assert workspace_material([], None) == ""


# --- the pipeline wiring ---------------------------------------------------- #
class _StubTranscription:
    async def transcribe(self, audio, filename, language=None, **_):
        return TranscriptResponse(transcript="Hello.", language="en", segments=[])


class _Llm:
    def __init__(self, questions=None, raises=False):
        self.questions = questions if questions is not None else ["A generated question?"]
        self.raises = raises
        self.material = None
        self.workspace = None

    async def summarize(self, transcript, language="en", *, template=None, **facts):
        return SummaryResponse(
            short_summary="The team moved the launch.",
            detailed_summary="d",
            key_points=[],
            sections=[_section("decisions", "Decisions", bullets=["Move the launch."])],
            template_slug=template.slug if template else "general",
        )

    async def extract_action_items(self, transcript, language="en"):
        return []

    async def suggest_questions(self, material, *, workspace=False):
        if self.raises:
            raise RuntimeError("model unavailable")
        self.material = material
        self.workspace = workspace
        return self.questions


def _run(llm):
    pipeline = Pipeline(_StubTranscription(), llm)
    return asyncio.run(pipeline.process("mtg_1", b"", "a.wav"))


def test_generated_questions_reach_the_brief():
    llm = _Llm()
    result = _run(llm)
    assert result.suggestions == ["A generated question?"]
    # From the summary, not the transcript: a transcript is mostly connective
    # tissue, and a model reading one picks a vivid aside over the decision.
    assert "Move the launch." in llm.material
    assert "Hello." not in llm.material
    assert llm.workspace is False


def test_a_failed_suggestion_does_not_fail_the_meeting():
    """This is the last thing the pipeline does and the least important thing
    it produces. Raising here would fail a meeting that has already been
    transcribed, summarized and had its action items extracted — and would
    re-run all of it on retry."""
    result = _run(_Llm(raises=True))
    assert result.suggestions == []
    assert result.short_summary == "The team moved the launch."


def test_no_questions_is_a_valid_outcome():
    """Better than three generic ones: the UI has hand-written prompts to fall
    back on, and a generic chip is indistinguishable from a broken one."""
    assert _run(_Llm(questions=[])).suggestions == []


# --- what a meeting's chips can see ----------------------------------------- #

def test_commitments_are_part_of_a_meetings_material():
    """The one thing a summary cannot supply.

    A summary records what was said; it never records what somebody was left
    holding. "Status of the pricing follow-up?" is a question about this meeting
    that no amount of summary text suggests, and before this the generator had
    no way to know the meeting produced any work at all.
    """
    material = meeting_material(
        "The team moved the launch to April.",
        [_section("decisions", "Decisions", bullets=["Move the launch to April."])],
        title="Launch sync",
        action_items=["Send the revised pricing to Acme", "Book the vendor call"],
    )

    assert "Send the revised pricing to Acme" in material
    assert "Book the vendor call" in material


def test_the_commitments_are_bounded_like_everything_else():
    material = meeting_material(
        "A busy meeting.",
        [],
        action_items=[f"item number {i}" for i in range(40)],
    )

    # Past a handful these stop adding distinct things to ask about and start
    # adding tokens, on every meeting the product ever processes.
    assert material.count("item number") <= 6


def test_no_commitments_adds_no_heading():
    material = meeting_material("A quiet meeting.", [], action_items=[])

    # An "Action items" heading with nothing under it tells the generator this
    # meeting produced work, which is the opposite of true.
    assert "Action items" not in material
