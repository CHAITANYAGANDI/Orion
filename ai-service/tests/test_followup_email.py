"""Follow-up email drafting.

The risk with a generated recap is not that it reads badly — it is that the user
forwards it without re-reading and ships a commitment nobody made. These tests
pin the draft to the supplied brief.
"""

from __future__ import annotations

import pytest

from app.providers.mock_adapter import SCRIPTS, MockLlmAdapter
from app.schemas import DraftEmailRequest

WEEK_1 = SCRIPTS[0]


@pytest.fixture
def llm() -> MockLlmAdapter:
    return MockLlmAdapter()


def _brief(**overrides) -> DraftEmailRequest:
    base = {
        "title": "Sprint planning",
        "short_summary": "The team agreed to store audio in S3 and use Whisper.",
        "key_points": ["Store audio in S3.", "Use Whisper."],
        "decisions": [d.decision for d in WEEK_1.decisions],
        "action_items": ["Chaitanya: Finish JWT validation (due Friday)"],
    }
    base.update(overrides)
    return DraftEmailRequest(**base)


@pytest.mark.asyncio
async def test_draft_includes_decisions_and_actions(llm):
    draft = await llm.draft_followup_email(_brief())
    assert "Sprint planning" in draft.subject
    assert "What we decided:" in draft.body
    assert "Next steps:" in draft.body
    assert "Chaitanya" in draft.body


@pytest.mark.asyncio
async def test_draft_contains_only_supplied_facts(llm):
    """Every bullet must trace back to the brief — nothing invented."""
    brief = _brief(decisions=["Ship on Tuesday."], action_items=[], key_points=[])
    draft = await llm.draft_followup_email(brief)
    assert "Ship on Tuesday." in draft.body
    # An empty section is omitted rather than padded with filler.
    assert "Next steps:" not in draft.body


@pytest.mark.asyncio
async def test_empty_sections_are_omitted(llm):
    brief = _brief(decisions=[], action_items=[], key_points=[])
    draft = await llm.draft_followup_email(brief)
    assert "What we decided:" not in draft.body
    assert "Next steps:" not in draft.body
    assert "Key points:" not in draft.body
    # Still a sendable email, not an empty string.
    assert brief.title in draft.body


@pytest.mark.asyncio
async def test_key_points_only_used_as_a_fallback(llm):
    """Key points pad the email only when there is nothing more concrete."""
    with_decisions = await llm.draft_followup_email(_brief())
    assert "Key points:" not in with_decisions.body

    without = await llm.draft_followup_email(
        _brief(decisions=[], action_items=[], key_points=["Ship on Tuesday."])
    )
    assert "Key points:" in without.body


@pytest.mark.asyncio
async def test_draft_is_deterministic(llm):
    a = await llm.draft_followup_email(_brief())
    b = await llm.draft_followup_email(_brief())
    assert a == b


def test_draft_endpoint_shape(client):
    resp = client.post(
        "/ai/draft-email",
        json={
            "title": "Sprint planning",
            "shortSummary": "We agreed on S3.",
            "decisions": ["Use S3."],
            "actionItems": ["Ana: benchmark (due Thu)"],
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert {"subject", "body"} <= set(body.keys())
    assert body["subject"]
    assert "Use S3." in body["body"]
