"""Which suggester answers, and what it is allowed to look at.

Home and Add context are the same endpoint asked two different questions, and
the difference is the whole point of §14-16: with nothing selected the chips
should be about the archive, and with meetings selected they should be about
those meetings and nothing else.

Getting this backwards is what shipped. Home generated its chips from whichever
twelve meetings happened to be most recent, so a user with one product-marketing
call was offered it as the entry point to fifty unrelated meetings — and Add
context did not change the chips at all, so selecting three meetings left the
same generic row on screen, which reads as the picker not having worked.

The route is exercised rather than the pieces, because the routing *is* the
behaviour: every piece here already works in isolation.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers.ai import get_pipeline, get_rag


class _FakeRag:
    def __init__(self, material="", signals=None):
        self._material = material
        self._signals = signals or {}
        self.material_calls: list = []

    async def workspace_material(self, user_id, meeting_ids=None):
        self.material_calls.append(meeting_ids)
        return self._material

    async def workspace_signals(self, user_id):
        return self._signals


class _FakePipeline:
    def __init__(self, questions=()):
        self._questions = list(questions)
        self.scopes: list = []

    async def suggest_questions(self, material, *, workspace=False, scope="workspace"):
        self.scopes.append(scope)
        return list(self._questions)


def wire_client(rag, pipeline):
    """Point the route at fakes. Cleared after every test by `_clean`."""
    app.dependency_overrides[get_rag] = lambda: rag
    app.dependency_overrides[get_pipeline] = lambda: pipeline
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clean():
    yield
    app.dependency_overrides.clear()


def _post(client, body):
    return client.post("/ai/suggestions/workspace", json=body).json()["suggestions"]


# --- Home, nothing selected -------------------------------------------------- #

def test_the_workspaces_own_state_leads():
    rag = _FakeRag("Recent meetings:\n- A", {"overdue": 3, "open_items": 8, "decisions": 2})
    pipeline = _FakePipeline(["What recurred across the quarter?"])

    out = _post(wire_client(rag, pipeline), {"userId": "usr_1"})

    # Grounded in a fact about the archive rather than in a model's reading of
    # twelve summaries — and the reason Home is not just a generated row.
    assert out[0] == "What overdue commitments need attention?"
    assert "What recurred across the quarter?" in out
    assert pipeline.scopes == ["workspace"]


def test_the_whole_archive_is_read_when_nothing_is_selected():
    rag = _FakeRag("material", {"open_items": 1})
    _post(wire_client(rag, _FakePipeline()), {"userId": "usr_1"})

    assert rag.material_calls == [None]


def test_an_empty_workspace_offers_nothing_rather_than_the_floor():
    """The UI has its own written-by-hand prompts for this.

    Blending the static floor in here would offer "What still needs to be
    completed?" to somebody who has never recorded anything — a chip that
    answers itself on the one screen where the reader has least context.
    """
    out = _post(wire_client(_FakeRag("", {}), _FakePipeline()), {"userId": "usr_1"})

    assert out == []


def test_a_workspace_with_signals_but_no_summaries_still_has_something_to_ask():
    rag = _FakeRag("", {"overdue": 0, "open_items": 4, "decisions": 0})

    out = _post(wire_client(rag, _FakePipeline()), {"userId": "usr_1"})

    assert "What still needs to be completed?" in out


# --- Home, with Add context -------------------------------------------------- #

def test_a_selection_is_answered_from_the_selection():
    rag = _FakeRag("Recent meetings:\n- Pricing review")
    pipeline = _FakePipeline(["Where do these three disagree?"])

    out = _post(
        wire_client(rag, pipeline),
        {"userId": "usr_1", "meetingIds": ["mtg_a", "mtg_b", "mtg_c"]},
    )

    assert out == ["Where do these three disagree?"]
    # The brief is different too: naming real topics is wrong for an archive and
    # right for a set somebody picked deliberately.
    assert pipeline.scopes == ["selection"]
    assert rag.material_calls == [["mtg_a", "mtg_b", "mtg_c"]]


def test_a_selection_does_not_inherit_the_workspaces_signals():
    """Signals are facts about the whole archive.

    Mixing "What overdue commitments need attention?" into chips for three
    meetings somebody just chose is the picker appearing not to have worked,
    which is the bug this half exists to fix.
    """
    rag = _FakeRag("material", {"overdue": 9, "open_items": 20, "decisions": 5})
    pipeline = _FakePipeline(["What carried over between these?"])

    out = _post(wire_client(rag, pipeline), {"userId": "usr_1", "meetingIds": ["mtg_a"]})

    assert out == ["What carried over between these?"]
    assert not any("overdue" in q.lower() for q in out)


def test_a_selection_with_nothing_to_read_offers_nothing():
    rag = _FakeRag("", {"overdue": 5})

    out = _post(wire_client(rag, _FakePipeline()), {"userId": "usr_1", "meetingIds": ["mtg_a"]})

    # A meeting still processing, or one with no summary yet. The static floor
    # would be worse than an empty row: it describes the archive, and the reader
    # has just said they are asking about one meeting.
    assert out == []
