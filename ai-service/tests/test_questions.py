"""Telling a lookup apart from an inventory.

Both failure directions are silent, and they are not equally bad:

* a missed inventory gives the answer we already had — complete but merged, so
  the reader counts thirteen bullets for fifteen items
* a false positive puts a bullet list and "Total: 4." at the bottom of a
  follow-up email somebody is about to send

The second is visible and embarrassing, so composition wins over enumeration
wherever the two collide. These tests pin that asymmetry, and cover every
built-in starter prompt, since those are the questions most users will ever ask.
"""

from __future__ import annotations

import asyncio

import pytest

from app.questions import wants_full_list
from app.rag import RagService


# --- inventories ------------------------------------------------------------ #
@pytest.mark.parametrize(
    "question",
    [
        # The one this was built for.
        "Across my meetings, what was committed to but does not appear to have been completed?",
        "What hasn't been completed?",
        "What has not been finished?",
        "What is still outstanding?",
        "Show me everything still open.",
        "List the action items.",
        "Give me the full list of decisions.",
        "How many commitments are open?",
        "What are all the risks raised this month?",
        "Find every discussion about pricing.",
        "List each decision and who made it.",
        "Who owes what?",
        "Which questions were never answered?",
    ],
)
def test_inventory_questions_ask_for_enumeration(question):
    assert wants_full_list(question) is True


# --- lookups ---------------------------------------------------------------- #
@pytest.mark.parametrize(
    "question",
    [
        "What did we decide about pricing?",
        "Who owns the migration?",
        "When is the launch?",
        "Why did we drop the cache?",
        "What did Sarah say about the vendor?",
        "Is the Acme SOW signed?",
        "",
    ],
)
def test_lookups_stay_prose(question):
    """A count on the end of a one-sentence answer is noise."""
    assert wants_full_list(question) is False


# --- composition wins ------------------------------------------------------- #
@pytest.mark.parametrize(
    "question",
    [
        # Contains "left open" but wants an agenda, not an audit.
        "Based on what was left open in this meeting, draft an agenda for the next one.",
        # Contains "action items" and would otherwise pick up "each".
        "Draft a follow-up email summarizing this meeting and its action items.",
        "Write up every point raised as a memo.",
        "Summarize all the decisions.",
        "Rewrite the summary listing each risk.",
    ],
)
def test_a_request_to_write_something_is_never_an_inventory(question):
    """Otherwise the artefact ships with 'Total: 6.' stapled to the bottom.

    A wrongly-prose answer is merely shorter; a wrongly-enumerated email is
    something the user forwards to a client with a footer they did not write.
    """
    assert wants_full_list(question) is False


# --- the built-in starter prompts ------------------------------------------- #
def test_every_starter_prompt_is_classified_deliberately():
    """The chips are the questions most users will ever ask.

    Kept as an explicit table rather than an assertion about counts, so adding
    a prompt forces a decision about which kind of answer it wants instead of
    inheriting one.
    """
    expected = {
        # Meeting chat
        "Summarize this meeting.": False,
        "What did we decide in this meeting? List each decision and who made it.": True,
        "What deadlines, dates or timelines were discussed, and what is due on each?": True,
        "Who committed to what in this meeting? List each commitment with the person who made it.": True,
        "List the questions raised in this meeting that were not answered or resolved.": True,
        "Draft a follow-up email summarizing this meeting and its action items, ready to send to the participants.": False,
        "Based on what was left open in this meeting, draft an agenda for the next one.": False,
        # Workspace chat
        "Across my meetings, what was committed to but does not appear to have been completed?": True,
        "What changed since last week's meeting? Compare what was said then with what was said most recently.": False,
        "Compare the meetings I have selected: where do they agree, where do they differ, and what changed between them?": False,
        "Find every discussion about ": True,
        "What did ": False,
        "Do any decisions in my recent meetings conflict with decisions made earlier? Quote both.": False,
    }
    for question, wanted in expected.items():
        assert wants_full_list(question) is wanted, question


# --- the flag actually reaches the model ------------------------------------ #
# Classification is worthless if it stops at the classifier. Both chats have to
# pass it through, and the meeting chat is the one likely to be forgotten:
# the ledger that motivated this only exists in the workspace chat, so it is
# easy to wire one and not the other and never notice.
class _Cursor:
    def __init__(self, rows):
        self._rows = rows

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def execute(self, sql, params=None):
        return None

    async def fetchall(self):
        return self._rows


class _Conn:
    def __init__(self, rows):
        self._rows = rows

    def cursor(self):
        return _Cursor(self._rows)


class _Llm:
    def __init__(self):
        self.exhaustive = None

    async def answer(self, question, context, *, exhaustive=False):
        self.exhaustive = exhaustive
        return "an answer"


def _service(rows):
    service = RagService.__new__(RagService)
    llm = _Llm()

    class _Ctx:
        async def __aenter__(self):
            return _Conn(rows)

        async def __aexit__(self, *exc):
            return False

    class _Embedder:
        async def embed(self, texts):
            return [[0.1, 0.2, 0.3] for _ in texts]

    class _Settings:
        rag_workspace_top_k = 10
        rag_top_k = 10

    service.connection = lambda user_id=None: _Ctx()  # type: ignore[assignment]
    service._pool = object()  # type: ignore[attr-defined]
    service._embedder = _Embedder()  # type: ignore[attr-defined]
    service._llm = llm  # type: ignore[attr-defined]
    service._settings = _Settings()  # type: ignore[attr-defined]

    async def _none(*_a, **_k):
        return []

    service._commitment_context = _none  # type: ignore[assignment]
    service._decision_context = _none  # type: ignore[assignment]
    return service, llm


def _workspace_row():
    return (0, "text", 1.0, 2.0, "mtg_1", "A meeting", None, 0.1)


@pytest.mark.parametrize(
    "question,expected",
    [
        ("Across my meetings, what has not been completed?", True),
        ("What did we decide about pricing?", False),
    ],
)
def test_workspace_chat_passes_the_flag_through(question, expected):
    service, llm = _service([_workspace_row()])
    asyncio.run(service.answer_workspace("usr_1", question))
    assert llm.exhaustive is expected


@pytest.mark.parametrize(
    "question,expected",
    [
        ("List every question that went unanswered.", True),
        ("Who owns the migration?", False),
    ],
)
def test_meeting_chat_passes_the_flag_through(question, expected):
    service, llm = _service([(0, "text", 1.0, 2.0)])
    asyncio.run(service.answer("mtg_1", question))
    assert llm.exhaustive is expected
