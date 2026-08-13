"""Action-item status reaching workspace chat.

Retrieval only ever sees transcript text, which records what people promised
and cannot record what happened next. Without the tracker, "what hasn't been
completed?" confidently lists work the user closed last week — the answer is
fluent, grounded in real quotes, and wrong.

These cover the ordering and the completed-items decision, both of which are
easy to get backwards in ways no error would ever surface.
"""

from __future__ import annotations

import asyncio

import pytest

from app.rag import RagService


class _Cursor:
    def __init__(self, rows):
        self._rows = rows
        self.executed: list[tuple] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def execute(self, sql, params=None):
        self.executed.append((sql, params))

    async def fetchall(self):
        return self._rows


class _Conn:
    def __init__(self, rows, fail=False):
        self._rows = rows
        self._fail = fail

    def cursor(self):
        if self._fail:
            raise RuntimeError("tracker unavailable")
        return _Cursor(self._rows)


def _service(rows, fail=False) -> RagService:
    service = RagService.__new__(RagService)  # no DB, no embedder

    class _Ctx:
        async def __aenter__(self):
            return _Conn(rows, fail)

        async def __aexit__(self, *exc):
            return False

    service.connection = lambda user_id=None: _Ctx()  # type: ignore[assignment]
    return service


def _run(service, **kwargs):
    return asyncio.run(service._commitment_context("usr_1", **kwargs))


def test_status_reaches_the_model():
    out = _run(_service([("Send the pricing deck", "OPEN", "Sarah", "2026-08-20", "Acme kickoff")]))
    body = "\n".join(out)
    assert "Send the pricing deck" in body
    assert "OPEN" in body
    assert "owner: Sarah" in body
    assert "due: 2026-08-20" in body
    assert "Acme kickoff" in body


def test_completed_items_are_included_not_filtered():
    # Filtering DONE out lets the model infer that anything it remembers from a
    # transcript and cannot see here is still outstanding — the same wrong
    # answer by a longer route. Seeing DONE is what stops it.
    out = _run(_service([("Ship the migration", "DONE", None, None, "Sprint review")]))
    body = "\n".join(out)
    assert "Ship the migration" in body
    assert "DONE" in body


def test_a_header_marks_these_as_status_not_transcript():
    out = _run(_service([("Anything", "OPEN", None, None, "A meeting")]))
    # Without it these read as more transcript, and get quoted back as things
    # somebody said out loud in a meeting.
    assert "current status" in out[0].lower()
    assert "done" in out[0].lower()


def test_nothing_tracked_adds_nothing():
    # Not even the header: an empty ledger presented as authoritative invites
    # "you have no outstanding items" for a user who simply has none extracted.
    assert _run(_service([])) == []


def test_a_broken_tracker_degrades_instead_of_failing():
    # This is an enrichment. Losing it costs accuracy on one question; raising
    # would cost the user every answer.
    assert _run(_service([], fail=True)) == []


def test_outstanding_work_is_ordered_before_finished_work():
    service = _service([])
    captured: dict = {}

    class _Cur(_Cursor):
        async def execute(self, sql, params=None):
            captured["sql"] = sql

    class _C:
        def cursor(self):
            return _Cur([])

    class _Ctx:
        async def __aenter__(self):
            return _C()

        async def __aexit__(self, *exc):
            return False

    service.connection = lambda user_id=None: _Ctx()  # type: ignore[assignment]
    asyncio.run(service._commitment_context("usr_1"))

    # The LIMIT truncates; if DONE sorted first it would drop the live work that
    # the question is actually about.
    assert "WHEN 'DONE' THEN 1 ELSE 0 END" in captured["sql"]
    assert "LIMIT" in captured["sql"]


def test_selected_meetings_narrow_the_ledger():
    service = _service([])
    captured: dict = {}

    class _Cur(_Cursor):
        async def execute(self, sql, params=None):
            captured["sql"] = sql
            captured["params"] = params

    class _C:
        def cursor(self):
            return _Cur([])

    class _Ctx:
        async def __aenter__(self):
            return _C()

        async def __aexit__(self, *exc):
            return False

    service.connection = lambda user_id=None: _Ctx()  # type: ignore[assignment]
    asyncio.run(service._commitment_context("usr_1", meeting_ids=["mtg_1", "mtg_2"]))

    # Restricting chat to three meetings must restrict the ledger too, or the
    # answer cites commitments from meetings the user excluded.
    assert "a.meeting_id = ANY" in captured["sql"]
    assert ["mtg_1", "mtg_2"] in captured["params"]


def test_the_ledger_is_scoped_to_the_user():
    service = _service([])
    captured: dict = {}

    class _Cur(_Cursor):
        async def execute(self, sql, params=None):
            captured["sql"] = sql
            captured["params"] = params

    class _C:
        def cursor(self):
            return _Cur([])

    class _Ctx:
        async def __aenter__(self):
            return _C()

        async def __aexit__(self, *exc):
            return False

    service.connection = lambda user_id=None: _Ctx()  # type: ignore[assignment]
    asyncio.run(service._commitment_context("usr_1"))

    assert "m.user_id = %s" in captured["sql"]
    assert captured["params"][0] == "usr_1"
