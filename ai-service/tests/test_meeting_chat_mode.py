"""Express and Advanced on the single-meeting chat.

The choice existed on the workspace chat and not here, on the recorded ground
that one meeting was "retrieved in full either way". It was not. Retrieval takes
the `rag_top_k` nearest passages, and a fifteen-minute recording already chunks
to more than that -- so a long meeting was answered from a sample of itself, and
which part of the sample depended on the question's embedding. That is the shape
of bug nobody reports, because a partial answer still reads like a whole one.

What is asserted here is the two things the modes differ in, because they are
the two things that would silently stop working: how many passages the query
asks for, and whether the answer is told to enumerate.
"""

from __future__ import annotations

import asyncio

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
    def __init__(self):
        self.exhaustive = None
        self.context = None

    async def answer(self, question, context, *, exhaustive=False, **kw):
        # The port carries intent, depth and history now. Swallowed rather
        # than asserted on here: each of these files is about one thing, and
        # the new arguments have tests of their own.
        self.kwargs = kw
        self.context = context
        self.exhaustive = exhaustive
        return "an answer"


EXPRESS_K = 8
DEEP_K = 24
MULTIPLIER = 3


def _service(rows) -> tuple[RagService, list, _Llm]:
    service = RagService.__new__(RagService)
    log: list = []
    llm = _Llm()

    class _Ctx:
        async def __aenter__(self):
            return _Conn(rows, log)

        async def __aexit__(self, *exc):
            return False

    service.connection = lambda user_id=None: _Ctx()  # type: ignore[assignment]
    service._pool = object()  # type: ignore[attr-defined]
    service._embedder = _Embedder()  # type: ignore[attr-defined]
    service._llm = llm  # type: ignore[attr-defined]

    service._settings = rag_settings(  # type: ignore[attr-defined]
        rag_top_k=EXPRESS_K,
        rag_deep_top_k=DEEP_K,
        rag_candidate_multiplier=MULTIPLIER,
    )
    return service, log, llm


def _rows(n=3, distance=0.5):
    # (chunk_index, text, start, end, distance)
    #
    # Distances are equal and comfortably inside the relevance ceiling, so
    # every row survives filtering. This file is about the two modes; the
    # filter has tests of its own in test_retrieval.py, and letting it fire
    # here would make these assertions about it instead.
    # Distinct words, not "passage 0/1/2": the near-duplicate filter works on
    # content words and would collapse three passages whose only content word
    # is "passage" -- correctly, which is exactly why the fixture must not be
    # three of the same sentence.
    subjects = ["pricing", "migration", "hiring", "roadmap", "renewal", "latency"]
    return [
        (i, f"we talked about {subjects[i % len(subjects)]} number {i}",
         float(i), float(i) + 1.0, distance)
        for i in range(n)
    ]


def _ask(service, question, mode="express"):
    return asyncio.run(service.answer("mtg_1", question, "usr_1", mode))


def _limit(log):
    """The LIMIT the retrieval query was given — the candidate budget.

    Not the answer budget any more. Retrieval over-fetches and then filters, so
    what the SQL asks for is a multiple of what survives; the two were the same
    number back when everything retrieved became evidence.
    """
    assert len(log) == 1, log
    _sql, params = log[0]
    return params[-1]


def test_express_retrieves_the_ordinary_width():
    service, log, _llm = _service(_rows())

    _ask(service, "What did we decide?")

    assert _limit(log) == EXPRESS_K * MULTIPLIER


def test_advanced_retrieves_wider():
    service, log, _llm = _service(_rows())

    _ask(service, "What did we decide?", mode="advanced")

    # The whole point of the setting. Eight passages of an hour-long meeting is
    # a fraction of it, and the fraction is chosen by embedding distance.
    assert _limit(log) == DEEP_K * MULTIPLIER


def test_an_unknown_mode_is_express():
    service, log, _llm = _service(_rows())

    # A client from a newer build, or a typo. Answering with the safe default
    # beats refusing to answer -- the same rule ChatMode.of follows in Spring.
    _ask(service, "What did we decide?", mode="thorough")

    assert _limit(log) == EXPRESS_K * MULTIPLIER


def test_express_enumerates_only_when_the_question_asks_for_a_list():
    service, _log, llm = _service(_rows())

    _ask(service, "What did Priya say about pricing?")
    assert llm.exhaustive is False

    _ask(service, "List every open question")
    assert llm.exhaustive is True


def test_advanced_does_not_turn_every_question_into_an_inventory():
    """Reversed on purpose, and this is the reasoning.

    Advanced used to force enumeration on everything on the argument that asking
    for Advanced is asking to be told everything. What that produced, for a
    question with one answer, was a single bullet followed by the line
    "Total: 1." — an audit report where somebody had asked what a word meant.

    Depth is a claim about evidence: look at more of the archive, cover more of
    what it supports. Whether the answer is a counted list is a claim about the
    question. Advanced widens the first and now leaves the second alone.
    """
    service, _log, llm = _service(_rows())

    _ask(service, "What does JWT mean in this meeting?", mode="advanced")
    assert llm.exhaustive is False

    # And an inventory is still an inventory in either mode: a reader who asked
    # for every open question is counting whichever mode they are in.
    _ask(service, "List every open question", mode="advanced")
    assert llm.exhaustive is True


def test_the_mode_reaches_the_model_as_depth():
    """The other half of the difference, and the one invisible in the SQL: the
    same passages are written up differently."""
    service, _log, llm = _service(_rows())

    _ask(service, "What did we decide?")
    assert llm.kwargs["depth"] == "express"

    _ask(service, "What did we decide?", mode="advanced")
    assert llm.kwargs["depth"] == "advanced"


def test_the_mode_does_not_change_what_is_cited():
    service, _log, llm = _service(_rows(3))

    answer, citations = _ask(service, "What did we decide?", mode="advanced")

    # Citations are what survived filtering, whichever mode retrieved them. A
    # wider net must not mean a differently-shaped answer.
    #
    # This fake returns a bare string rather than an Answer, so it names no
    # passages — which is the documented fallback: cite everything retained.
    # That is what every caller did before the contract carried `used`, and it
    # is now a much smaller claim, because what is retained has been filtered.
    assert answer == "an answer"
    assert sorted(c["chunkIndex"] for c in citations) == [0, 1, 2]
    assert len(llm.context) == 3
