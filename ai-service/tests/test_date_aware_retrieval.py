"""Date-aware workspace retrieval: the wiring, not the parsing.

`test_timeframe` covers reading a window out of a question. This covers what
retrieval does with one, and every case here is a silent failure:

* the window parses but never reaches SQL — the question searches everything and
  answers "what changed since last week?" from March
* a comparison retrieves only the recent half — nothing to have changed from, so
  the model reports that all of it is new
* the two halves overlap on their shared boundary — the same passage is quoted
  as both "recent" and "earlier", and the answer contradicts itself
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

from app.rag import RagService, _passage


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
        self.context = None

    async def answer(self, question, context):
        self.context = context
        return "an answer"


def _row(title="Acme kickoff", text="some passage", when=datetime(2026, 8, 10, tzinfo=timezone.utc)):
    # (chunk_index, text, start, end, meeting_id, title, created_at, distance)
    return (0, text, 1.0, 2.0, "mtg_1", title, when, 0.1)


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
    # `enabled` reads the pool; any non-None value gets past the guard, and the
    # stubbed `connection` above is what the queries actually run through.
    service._pool = object()  # type: ignore[attr-defined]
    service._embedder = _Embedder()  # type: ignore[attr-defined]
    service._llm = llm  # type: ignore[attr-defined]

    class _Settings:
        rag_workspace_top_k = 8

    service._settings = _Settings()  # type: ignore[attr-defined]
    # The ledger enrichments run against the same stub connection and would
    # return the retrieval rows as action items. Silenced so the assertions
    # below are about retrieval.
    async def _none(*_a, **_k):
        return []

    service._commitment_context = _none  # type: ignore[assignment]
    service._decision_context = _none  # type: ignore[assignment]
    return service, log, llm


def _ask(service, question, meeting_ids=None):
    return asyncio.run(service.answer_workspace("usr_1", question, meeting_ids))


def _selects(log):
    """Only the retrieval queries, in the order they ran."""
    return [entry for entry in log if "transcript_chunks" in entry[0]]


# --- the filter actually reaches SQL ---------------------------------------- #
def test_a_question_without_a_period_filters_on_nothing():
    service, log, _ = _service([_row()])
    _ask(service, "What did we decide about pricing?")

    sql, _ = _selects(log)[0]
    # The predicates, not the column — `m.created_at` is in the SELECT list on
    # every query because the passage label needs it.
    assert "m.created_at >=" not in sql
    assert "m.created_at <" not in sql
    assert len(_selects(log)) == 1


def test_a_window_becomes_a_date_bound_in_sql():
    """Filtering in SQL, not after.

    Post-filtering takes the top-k of the whole archive and then discards most
    of it, which on a year of meetings leaves "last week" answering from
    whatever two chunks happened to survive.
    """
    service, log, _ = _service([_row()])
    _ask(service, "What did we discuss last week?")

    sql, params = _selects(log)[0]
    assert "m.created_at >= %s" in sql
    assert any(isinstance(p, datetime) for p in params)


def test_a_plain_lookup_runs_one_query():
    """No comparison asked for, so the older half is not fetched — it would
    spend half the context window on meetings the question excluded."""
    service, log, _ = _service([_row()])
    _ask(service, "What did we discuss last week?")
    assert len(_selects(log)) == 1


# --- comparisons ------------------------------------------------------------ #
def test_a_comparison_retrieves_both_halves():
    service, log, _ = _service([_row()])
    _ask(service, "What changed since last week?")

    selects = _selects(log)
    assert len(selects) == 2


def test_the_two_halves_meet_at_one_boundary_and_do_not_overlap():
    """`recent` starts where `earlier` ends, exactly.

    An inclusive-on-both-sides split would return a meeting on the boundary in
    both halves, and the answer would cite the same passage as evidence of what
    is new and of what it replaced.
    """
    service, log, _ = _service([_row()])
    _ask(service, "What changed since last week?")

    recent_sql, recent_params = _selects(log)[0]
    earlier_sql, earlier_params = _selects(log)[1]

    assert "m.created_at >= %s" in recent_sql
    assert "m.created_at <" in earlier_sql
    recent_start = next(p for p in recent_params if isinstance(p, datetime))
    earlier_end = next(p for p in earlier_params if isinstance(p, datetime))
    assert recent_start == earlier_end


def test_the_older_half_is_labelled_as_comparison_only():
    """Unlabelled, a passage from six weeks ago is indistinguishable from one
    from Tuesday, and gets reported as the current state of things."""
    service, _, llm = _service([_row()])
    _ask(service, "What changed since last week?")

    body = "\n".join(llm.context)
    assert "comparison only" in body
    assert "never present it as recent" in body


def test_a_comparison_splits_the_budget_rather_than_doubling_it():
    """The context window is the same size either way."""
    service, log, _ = _service([_row()])
    _ask(service, "What changed since last week?")

    limits = [entry[1][-1] for entry in _selects(log)]
    assert sum(limits) == 8


# --- what the model is shown ------------------------------------------------ #
def test_every_passage_carries_its_meeting_date():
    """Which of two contradictory statements came later is only answerable if
    the model can see when each was said."""
    row = _row(title="Acme kickoff", when=datetime(2026, 8, 10, tzinfo=timezone.utc))
    assert _passage(row) == "[Meeting: Acme kickoff · 2026-08-10] some passage"


def test_a_passage_without_a_usable_date_still_renders():
    """A row whose created_at is missing must not take the whole answer down."""
    row = (0, "text", 1.0, 2.0, "mtg_1", "A meeting", None, 0.1)
    assert _passage(row) == "[Meeting: A meeting] text"


def test_an_empty_window_says_so_instead_of_answering_from_elsewhere():
    """The failure this replaces: no meetings last week, so retrieval widens by
    accident and the answer describes March as though it were recent."""
    service, _, _ = _service([])
    answer, citations = _ask(service, "What changed since last week?")

    assert "the last 7 days" in answer
    assert citations == []


def test_no_meetings_at_all_reads_differently_from_none_in_the_window():
    service, _, _ = _service([])
    answer, _ = _ask(service, "What did we decide about pricing?")
    assert "indexed meetings" in answer


# --- narrowing still applies ------------------------------------------------ #
def test_selected_meetings_narrow_both_halves():
    """Restricting chat to three meetings must survive the date split, or a
    comparison quotes meetings the user deselected."""
    service, log, _ = _service([_row()])
    _ask(service, "What changed since last week?", meeting_ids=["mtg_1", "mtg_2"])

    for sql, params in _selects(log):
        assert "c.meeting_id = ANY(%s)" in sql
        assert ["mtg_1", "mtg_2"] in params


def test_retrieval_stays_scoped_to_the_user():
    service, log, _ = _service([_row()])
    _ask(service, "What changed since last week?")

    for sql, params in _selects(log):
        assert "c.user_id = %s" in sql
        assert "usr_1" in params
