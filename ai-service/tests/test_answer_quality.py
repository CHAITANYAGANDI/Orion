"""The bug report, end to end.

A user asked "What were the key product features highlighted?" and got:

    "I found three potentially relevant recordings mentioning 'product' and
    'features,' but the matches are fuzzy and don't clearly list 'key product
    features' by name: [three meeting titles] ... To get you a precise list,
    could you specify ..."

Every sentence of that was true. The whole of it was a failure: a reader asked
what was discussed in their meetings and was handed a report on a search engine,
ending in a request to do the work themselves.

Two causes, and this file holds one test for each side of both.

**Retrieval had no opinion.** `LIMIT k` returns k rows whether or not any of
them are about the question, so the unrelated meeting was evidence, went in the
prompt, and came back as a citation.

**The brief never said where an answer starts.** Handed weak passages and told
only to be concise and to say so if it did not know, the model described its
evidence — which is the reasonable reading of that instruction and the wrong
thing for a reader to receive.

The workspace here is the one from the report: a meeting that answers the
question, a promotional clip that says "product" once, and something unrelated.
"""

from __future__ import annotations

import asyncio

from app import answering
from app.answering import Answer
from app.rag import RagService
from tests.conftest import rag_settings


class _Cursor:
    def __init__(self, rows, log):
        self._rows = rows
        self._log = log

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def execute(self, sql, params=None):
        self._log.append((sql, params))

    async def fetchall(self):
        return self._rows

    async def fetchone(self):
        return self._rows[0] if self._rows else None


class _Conn:
    def __init__(self, rows, log):
        self._rows = rows
        self._log = log

    def cursor(self):
        return _Cursor(self._rows, self._log)


class _Embedder:
    async def embed(self, texts):
        return [[0.1, 0.2, 0.3] for _ in texts]


class _Llm:
    """Records the brief it was given and returns a fixed, grounded-looking answer."""

    def __init__(self, used=()):
        self.context = None
        self.kwargs = None
        self.exhaustive = None
        self._used = used

    async def answer(self, question, context, *, exhaustive=False, **kw):
        self.context = context
        self.exhaustive = exhaustive
        self.kwargs = kw
        return Answer(text="Three themes stood out.", used=self._used)


def _row(meeting, index, text, distance, title=None):
    return (index, text, 0.0, 1.0, meeting, title or meeting.upper(), None, distance)


# Distances are the measured ones — see tests/test_retrieval.py.
PRODUCT_MARKETING = [
    _row("mtg_a", 0, "we should improve support around the major industry events", 0.613,
         "Product Marketing Weekly"),
    _row("mtg_a", 1, "each stage highlights three significant improvements", 0.631,
         "Product Marketing Weekly"),
    _row("mtg_a", 2, "monthly active users tell us which features deserve emphasis", 0.652,
         "Product Marketing Weekly"),
    _row("mtg_a", 3, "customer demand is the other prioritisation signal", 0.664,
         "Product Marketing Weekly"),
]
CONFERENCE_CLIP = [
    _row("mtg_b", 0, "come and see our product at the conference next week", 0.780,
         "Tech in Asia Conference"),
]
UNRELATED = [
    _row("mtg_c", 0, "the sourdough starter needs feeding twice a day", 0.881,
         "Saturday plans"),
]

QUESTION = "What were the key product features highlighted?"


def _service(rows, llm=None, settings=None):
    service = RagService.__new__(RagService)
    log: list = []
    llm = llm or _Llm()

    class _Ctx:
        async def __aenter__(self):
            return _Conn(rows, log)

        async def __aexit__(self, *exc):
            return False

    service.connection = lambda user_id=None: _Ctx()  # type: ignore[assignment]
    service._pool = object()  # type: ignore[attr-defined]
    service._embedder = _Embedder()  # type: ignore[attr-defined]
    service._llm = llm  # type: ignore[attr-defined]
    service._settings = settings or rag_settings()  # type: ignore[attr-defined]

    async def _none(*_a, **_k):
        return []

    service._commitment_context = _none  # type: ignore[assignment]
    service._decision_context = _none  # type: ignore[assignment]
    return service, log, llm


def _ask(service, question=QUESTION, mode="express", **kw):
    return asyncio.run(service.answer_workspace("usr_1", question, mode=mode, **kw))


def _meetings_in(llm):
    """Which meetings the model was actually shown."""
    return {
        line.split("[Meeting: ")[1].split(" ·")[0].split("]")[0]
        for line in (llm.context or [])
        if line.startswith("[Meeting: ")
    }


# --- what reaches the model -------------------------------------------------- #

def test_the_answer_comes_from_the_meeting_that_answers_it():
    service, _log, llm = _service(PRODUCT_MARKETING + CONFERENCE_CLIP + UNRELATED)

    _ask(service)

    shown = _meetings_in(llm)
    assert "Product Marketing Weekly" in shown
    # The heart of the report. An unrelated meeting was evidence because it was
    # the least-unrelated thing the archive had.
    assert "Saturday plans" not in shown
    # And the promotional clip, which matched on the word "product" and answers
    # nothing, is measurably behind the leader and goes with it.
    assert "Tech in Asia Conference" not in shown


def test_nothing_relevant_is_said_plainly_and_names_no_meetings():
    service, _log, llm = _service(UNRELATED)

    answer, citations = _ask(service)

    assert answer == "I couldn't find this in the meetings currently in scope."
    assert citations == []
    # Not "I found three potentially relevant recordings" followed by a list of
    # titles. A reader offered the names of meetings that do not answer their
    # question has been given work, not an answer.
    assert "Saturday" not in answer
    assert "found" not in answer.lower()
    # And the model is not asked at all, which is the other half: an answer
    # assembled from irrelevant passages costs a call and produces the reply
    # this whole change exists to stop.
    assert llm.context is None


def test_the_ledgers_still_answer_an_inventory_with_no_matching_passage():
    """The other half of the split, and the one easy to break by tightening.

    The action-item ledger is the complete record of what is owed, not a
    retrieved sample, so "what is still outstanding?" is answerable with no
    transcript passage at all. Refusing it because nothing cleared the relevance
    filter would be the memory feature regressing to make generic RAG tidier.
    """
    service, _log, llm = _service(UNRELATED)

    async def _ledger(*_a, **_k):
        return ["Tracked items follow:", "[Action item · OPEN · X] ship the thing"]

    service._commitment_context = _ledger  # type: ignore[assignment]

    answer, _citations = _ask(service, "What is still outstanding?")

    assert llm.context is not None
    assert answer == "Three themes stood out."


def test_an_empty_archive_still_says_how_to_start():
    """Distinct from having nothing relevant, and it must stay distinct.

    Telling somebody with no meetings that their question was not found in scope
    is technically true and useless. The one thing they need is the instruction
    that makes the feature work at all.
    """
    service, _log, _llm = _service([])

    answer, _citations = _ask(service)

    assert "Upload a meeting" in answer


# --- express and advanced ---------------------------------------------------- #

def test_advanced_scans_wider_than_express():
    service, log, _llm = _service(PRODUCT_MARKETING)
    _ask(service)
    express = log[-1][1][-1]

    service, log, _llm = _service(PRODUCT_MARKETING)
    _ask(service, mode="advanced")
    advanced = log[-1][1][-1]

    # Not a label on the same request. The candidate budget is what the wider
    # mode actually buys, and everything downstream is filtering it.
    assert advanced > express


def test_advanced_allows_more_of_each_meeting():
    """The second real difference, and the one that makes a synthesis possible.

    Express holds every meeting to three passages so no single talkative call
    fills the context. A comparison or a timeline is a claim about several
    meetings and needs more of each, so Advanced raises the cap rather than
    removing it.
    """
    many = [
        _row("mtg_a", i, f"we discussed {topic} in some detail", 0.62 + i * 0.005,
             "Product Marketing Weekly")
        for i, topic in enumerate(
            ["events", "announcements", "pricing", "hiring", "roadmap", "renewals"]
        )
    ]

    _s, _log, express = _service(many)
    _ask(_s)
    _s, _log, advanced = _service(many)
    _ask(_s, mode="advanced")

    assert len(express.context) == 3
    assert len(advanced.context) == 6


def test_the_mode_reaches_the_brief_as_depth():
    service, _log, llm = _service(PRODUCT_MARKETING)

    _ask(service, mode="advanced")

    assert llm.kwargs["depth"] == "advanced"
    assert llm.kwargs["intent"] == "fact"


def test_advanced_does_not_turn_a_lookup_into_an_inventory():
    """Reversed on purpose.

    Advanced used to force enumeration on every question, so "what does JWT mean
    here?" came back as one bullet under the line "Total: 1." — an audit report
    where somebody had asked what a word meant. Depth is a claim about evidence;
    whether the answer is a counted list is a claim about the question.
    """
    service, _log, llm = _service(PRODUCT_MARKETING)

    _ask(service, "What does JWT mean here?", mode="advanced")
    assert llm.exhaustive is False

    _ask(service, "List every open action item", mode="advanced")
    assert llm.exhaustive is True


def test_an_inventory_enumerates_in_express_too():
    """A reader who asked for every item is counting whichever mode they are in."""
    service, _log, llm = _service(PRODUCT_MARKETING)

    _ask(service, "List every open action item")

    assert llm.exhaustive is True


# --- citations ---------------------------------------------------------------- #

def test_only_the_passages_the_model_used_are_cited():
    llm = _Llm(used=(1, 3))
    service, _log, _llm = _service(PRODUCT_MARKETING, llm=llm)

    _answer, citations = _ask(service)

    # Attaching every retrieved passage asserts the model read all of them and
    # drew on all of them. Neither is true, and it is visibly untrue the moment
    # a reader clicks a source with nothing to do with the answer.
    #
    # Checked against the prompt the model was actually shown rather than
    # against the order rows arrived in: reranking reorders them, which is the
    # point of it.
    assert len(citations) == 2
    assert citations[0]["text"] in llm.context[0]
    assert citations[1]["text"] in llm.context[2]


def test_citations_are_counted_past_the_ledger_lines():
    """The ledger and the decision record are numbered passages too.

    A model citing [2] when the first two entries are action items is not citing
    the second transcript chunk. Getting this wrong attaches a citation to the
    wrong moment of the wrong meeting, which is worse than attaching none.
    """
    llm = _Llm(used=(3,))
    service, _log, _llm = _service(PRODUCT_MARKETING, llm=llm)

    async def _ledger(*_a, **_k):
        return ["Tracked items follow:", "[Action item · OPEN · X] ship the thing"]

    service._commitment_context = _ledger  # type: ignore[assignment]

    _answer, citations = _ask(service)

    # [1] and [2] are the ledger; [3] is the first transcript passage.
    assert len(citations) == 1
    assert citations[0]["text"] in llm.context[2]
    assert "Action item" not in citations[0]["text"]


def test_an_answer_that_names_no_passages_still_cites_what_survived():
    service, _log, _llm = _service(PRODUCT_MARKETING, llm=_Llm(used=()))

    _answer, citations = _ask(service)

    # The documented fallback, and now a far smaller claim than it was: what
    # survived has been through the relevance filter — and Express holds any one
    # meeting to three passages, so it is three of the four retrieved.
    assert len(citations) == 3


# --- the brief ----------------------------------------------------------------- #

def test_the_brief_forbids_narrating_the_search():
    prompt = answering.system_prompt(intent="fact", depth="express")

    assert "ANSWER FIRST" in prompt
    for phrase in ("potentially relevant", "matches are fuzzy", "retrieved passages"):
        assert phrase in prompt.lower() or phrase in prompt


def test_the_brief_forbids_asking_the_reader_to_do_the_work():
    prompt = answering.system_prompt(intent="fact", depth="express")

    assert "Do not ask the reader to narrow the question" in prompt
    assert "Do not end with an offer of further help" in prompt


def test_the_brief_keeps_every_grounding_rule():
    """Writing quality is not bought by loosening this."""
    prompt = answering.system_prompt(intent="summary", depth="advanced")

    assert "Use only the passages" in prompt
    assert "Never invent a fact" in prompt
    assert "DONE is done" in prompt
    assert "the later dated one holds" in prompt


def test_express_and_advanced_are_briefed_differently():
    express = answering.system_prompt(intent="fact", depth="express")
    advanced = answering.system_prompt(intent="fact", depth="advanced")

    assert "Be brief" in express
    assert "Go deeper" in advanced
    # Depth must not become licence to pad. "Advanced" answers that invent a
    # fourth theme to look thorough are the failure this guards.
    assert "do not add a point" in advanced.lower()


def test_each_intent_asks_for_a_different_shape():
    shapes = {
        "timeline": "Order the answer by date",
        "comparison": "which side is current",
        "synthesis": "Name each theme once",
        "compose": "Produce that artefact and nothing else",
    }
    for intent, expected in shapes.items():
        assert expected in answering.system_prompt(intent=intent)


def test_an_inventory_still_asks_for_a_count():
    prompt = answering.system_prompt(intent="inventory", exhaustive=True)

    assert "One bullet per item" in prompt
    assert "Total: N." in prompt


# --- the reply ------------------------------------------------------------------ #

def test_a_reply_names_the_passages_it_used():
    parsed = answering.parse({"answer": "Three themes.", "used": [1, 3]}, 4)

    assert parsed.text == "Three themes."
    assert parsed.used == (1, 3)


def test_a_passage_number_that_does_not_exist_is_dropped_not_clamped():
    parsed = answering.parse({"answer": "x", "used": [1, 9]}, 4)

    # A model citing [9] of four passages has miscounted. Clamping it to [4]
    # would turn a miscount into a false citation.
    assert parsed.used == (1,)


def test_a_bare_string_is_still_an_answer():
    parsed = answering.parse("Just prose.", 3)

    assert parsed.text == "Just prose."
    assert parsed.used == ()


def test_history_is_the_users_questions_and_not_the_answers():
    prompt = answering.user_prompt(
        "Which of those changed later?",
        ["[Meeting: A] something"],
        ["What product priorities were discussed?"],
    )

    assert "What product priorities were discussed?" in prompt
    # Named as reference material, not as evidence. Letting a previous answer
    # count as evidence is how one loose claim becomes the basis of the next.
    assert "They are not evidence" in prompt
