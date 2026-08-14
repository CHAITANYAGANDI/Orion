"""Decisions and risks read out of the summary.

The failures worth guarding here are the quiet ones. Nothing crashes when a
placeholder bullet becomes a stored risk, or when a section is read under the
wrong kind — the meeting page just shows a risk called "no risks", and workspace
chat is handed it as a decision to compare other decisions against.

These rows are also the authority the chat answers "does this conflict with what
we decided in March?" from, so a wrong one is a wrong answer rather than a
cosmetic blemish. That is why the derivation is tested harder than its size
suggests it deserves.
"""

from __future__ import annotations

import asyncio

import pytest

from app.insights import derive_insights
from app.schemas import SummarizeRequest, SummaryResponse, SummarySection
from app.templates import BUILT_IN


def _bullets(key: str, *bullets: str) -> SummarySection:
    return SummarySection(key=key, title=key, kind="bullets", bullets=list(bullets))


# --- what counts as what --------------------------------------------------- #
def test_a_decisions_section_becomes_decisions():
    out = derive_insights([_bullets("decisions", "Ship on the 14th, not the 7th.")])
    assert [(i.kind, i.text) for i in out] == [
        ("DECISION", "Ship on the 14th, not the 7th.")
    ]


@pytest.mark.parametrize("key", ["risks", "blockers", "concerns"])
def test_risk_shaped_sections_become_risks(key):
    out = derive_insights([_bullets(key, "The vendor contract is not signed yet.")])
    assert [i.kind for i in out] == ["RISK"]


@pytest.mark.parametrize("key", ["selected", "improvements"])
def test_sections_that_settle_something_count_as_decisions(key):
    """Brainstorm's "selected" and Retrospective's "improvements" are decisions.

    Both are written as things the group agreed to — "the ideas the group chose
    to take forward", "changes the team agreed to try". Reading them as anything
    else means those two templates produce no decision record at all.
    """
    out = derive_insights([_bullets(key, "Move the deploy window to Tuesdays.")])
    assert [i.kind for i in out] == ["DECISION"]


def test_commitments_are_not_decisions():
    """A 1:1's commitments are action items, and are already extracted as such.

    Counting them here would double every promise in the workspace: once in the
    tracker that knows whether it was done, and once in a decision record that
    does not.
    """
    assert derive_insights([_bullets("commitments", "Alice will send the deck by Friday.")]) == []


def test_unrelated_sections_are_ignored():
    sections = [
        _bullets("keyPoints", "Revenue is up 12 percent."),
        _bullets("nextSteps", "Reconvene on Thursday."),
        _bullets("wentWell", "The migration went smoothly."),
    ]
    assert derive_insights(sections) == []


def test_the_source_section_survives():
    """Without it a blocker and a risk are indistinguishable once stored.

    They land in the same table under the same kind, and the difference — one is
    already happening, the other might — is only recoverable from this field.
    """
    out = derive_insights([_bullets("blockers", "Waiting on the security review.")])
    assert out[0].source_section == "blockers"


# --- what must not be stored ------------------------------------------------ #
@pytest.mark.parametrize(
    "bullet",
    [
        "None.",
        "No blockers were raised.",
        "Nothing was decided.",
        "N/A",
        "There were no risks identified.",
        "Not applicable",
    ],
)
def test_a_bullet_saying_the_section_is_empty_is_not_stored(bullet):
    """Otherwise the store holds a risk called "no risks".

    It renders as a real row on the meeting page, and workspace chat is handed
    it as a decision to compare against other decisions.
    """
    assert derive_insights([_bullets("risks", bullet)]) == []
    assert derive_insights([_bullets("decisions", bullet)]) == []


def test_a_real_decision_that_merely_starts_with_no_is_kept():
    """The placeholder filter must not eat content.

    Anchored on the opening word, which is what makes it cheap — and what makes
    this case the one that proves the length ceiling is doing its job.
    """
    text = "None of the three vendors met the security bar, so we chose to build it in-house."
    out = derive_insights([_bullets("decisions", text)])
    assert [i.text for i in out] == [text]


def test_blank_and_trivial_bullets_are_dropped():
    out = derive_insights([_bullets("decisions", "", "   ", "ok", "Adopt the new schema.")])
    assert [i.text for i in out] == ["Adopt the new schema."]


def test_the_same_item_in_two_sections_is_stored_once():
    """Project Review has both Risks and Blockers.

    A team that names the same dependency in both should get one row, not two
    that a reader has to notice are the same sentence.
    """
    sections = [
        _bullets("risks", "The vendor contract is not signed."),
        _bullets("blockers", "the vendor contract is not signed."),
    ]
    out = derive_insights(sections)
    assert len(out) == 1
    assert out[0].source_section == "risks"


def test_a_prose_section_is_not_split_into_rows():
    """One paragraph is not a set of discrete items, and storing it whole puts
    an essay where a one-line row is expected."""
    section = SummarySection(
        key="decisions", title="Decisions", kind="prose", text="We decided several things."
    )
    assert derive_insights([section]) == []


# --- order, and the templates it runs against ------------------------------- #
def test_order_follows_the_template():
    """The store should read in the same order as the page it came from."""
    sections = [
        _bullets("decisions", "First decision.", "Second decision."),
        _bullets("risks", "First risk."),
    ]
    assert [i.text for i in derive_insights(sections)] == [
        "First decision.",
        "Second decision.",
        "First risk.",
    ]


# --- the summarize endpoint carries them ------------------------------------ #
class _StubPipeline:
    """Returns a fixed summary; the endpoint is what must derive from it."""

    def __init__(self, sections):
        self._sections = sections

    async def summarize(self, transcript, **kwargs):
        return SummaryResponse(
            short_summary="s",
            detailed_summary="d",
            key_points=[],
            sections=self._sections,
            template_slug="general",
        )


def _summarize(sections):
    from app.routers.ai import summarize

    req = SummarizeRequest(transcript="x", templateSlug="general")
    return asyncio.run(summarize(req, _StubPipeline(sections)))


def test_the_summarize_endpoint_derives_insights_too():
    """Re-summarizing under a different template goes through here, not the
    pipeline.

    Without this the notes change and the decision store keeps the previous
    template's rows — the store and the summary disagreeing on the same page,
    which is the exact failure deriving them was meant to make impossible.
    """
    out = _summarize(
        [
            _bullets("decisions", "Ship on the 14th."),
            _bullets("risks", "The contract is unsigned."),
        ]
    )
    assert [(i.kind, i.text) for i in out.insights] == [
        ("DECISION", "Ship on the 14th."),
        ("RISK", "The contract is unsigned."),
    ]


def test_a_template_that_settles_nothing_returns_an_empty_list_not_an_error():
    """Spring replaces the derived rows with whatever comes back, so an empty
    list has to mean "this template has no decisions" rather than a failure."""
    out = _summarize([_bullets("observations", "The candidate was strong.")])
    assert out.insights == []


def test_every_built_in_template_is_accounted_for():
    """A template must produce decisions, or risks, or be one of the two that
    deliberately produce neither.

    This catches a new template whose sections were named without checking
    against the derivation — which fails silently, as an empty Decisions card on
    every meeting of that type.
    """
    from app.insights import DECISION_KEYS, RISK_KEYS

    settles_nothing = {"one-on-one", "interview"}
    for tpl in BUILT_IN:
        keys = {s.key for s in tpl.sections}
        derives = bool(keys & (DECISION_KEYS | RISK_KEYS))
        if tpl.slug in settles_nothing:
            # A 1:1 produces commitments and an interview produces
            # observations. Neither settles anything, and inventing decisions
            # for them would be worse than the empty card.
            assert not derives, f"{tpl.slug} now derives insights; update this list"
        else:
            assert derives, f"{tpl.slug} produces neither decisions nor risks"
