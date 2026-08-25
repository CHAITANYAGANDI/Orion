"""Embedded chunks belong to a processing run, and a stale run cannot take over.

pgvector is the one piece of a meeting's derived state Spring does not write.
The worker indexes it directly, while the pipeline is running — minutes before
the result callback exists — so the stale-attempt check inside `applyResult`
never gets a chance to protect it. Before V58, a redelivered attempt-1
execution ran a blind `DELETE FROM transcript_chunks WHERE meeting_id = ?` and
put the old transcript back. Its result callback was then rejected as stale,
correctly and far too late: the meeting's page showed the new transcript and
"ask this meeting" answered from the one the user had asked to be replaced.

The table below is a small interpreter for the statements the indexer and
retrieval actually issue. It reads the predicates out of the SQL rather than
assuming them, so removing `AND processing_attempt <= %s` from the delete, or
the newest-generation filter from a query, makes these tests fail by deleting
and returning what the real database would.
"""

from __future__ import annotations

import asyncio

from app.rag import RagService
from tests.conftest import rag_settings


MEETING = "mtg_1"
USER = "usr_1"


class _Table:
    """transcript_chunks, as far as these statements are concerned."""

    def __init__(self) -> None:
        self.rows: list[dict] = []
        self.log: list[str] = []
        #: Called once the indexer's "is there a newer generation?" probe has
        #: answered, to open the race window deliberately.
        self.after_probe = None

    # --- statement dispatch ------------------------------------------------- #
    def execute(self, sql: str, params):
        self.log.append(sql)
        flat = " ".join(sql.split())

        if flat.startswith("SELECT 1 FROM transcript_chunks"):
            return self._probe(flat, params)
        if flat.startswith("DELETE FROM transcript_chunks"):
            return self._delete(flat, params)
        if flat.startswith("INSERT INTO transcript_chunks"):
            return self._insert(params)
        if "FROM transcript_chunks c" in flat:
            return self._select(flat, params)
        raise AssertionError(f"unrecognised statement: {flat[:120]}")

    def _probe(self, flat, params):
        meeting_id, attempt = params
        assert "processing_attempt > %s" in flat, flat
        self._result = [
            (1,) for r in self.rows
            if r["meeting_id"] == meeting_id and r["attempt"] > attempt
        ][:1]
        if self.after_probe is not None:
            hook, self.after_probe = self.after_probe, None
            hook()

    def _delete(self, flat, params):
        # Read the scope out of the statement. A delete that has lost its
        # generation predicate really does remove every generation here, which
        # is the regression these tests exist to catch.
        if "processing_attempt <= %s" in flat:
            meeting_id, attempt = params
            keep = lambda r: not (r["meeting_id"] == meeting_id and r["attempt"] <= attempt)
        else:
            (meeting_id,) = params
            keep = lambda r: r["meeting_id"] != meeting_id
        self.rows = [r for r in self.rows if keep(r)]
        self._result = []

    def _insert(self, params):
        # (id, meeting_id, user_id, chunk_index, text, start, end, vector[, attempt])
        row = {
            "meeting_id": params[1],
            "user_id": params[2],
            "chunk_index": params[3],
            "text": params[4],
            "start": params[5],
            "end": params[6],
            "attempt": params[8] if len(params) > 8 else 1,
        }
        self.rows.append(row)
        self._result = []

    def _select(self, flat, params):
        _vec, meeting_id, limit = params
        rows = [r for r in self.rows if r["meeting_id"] == meeting_id]
        if "NOT EXISTS" in flat:
            newest = max((r["attempt"] for r in rows), default=0)
            rows = [r for r in rows if r["attempt"] == newest]
        self._result = [
            (r["chunk_index"], r["text"], r["start"], r["end"], 0.4)
            for r in rows
        ][:limit]

    # --- what the caller sees ----------------------------------------------- #
    def fetchone(self):
        return self._result[0] if self._result else None

    def fetchall(self):
        return self._result

    def generations(self) -> set[int]:
        return {r["attempt"] for r in self.rows}

    def texts(self, attempt: int | None = None) -> list[str]:
        return [r["text"] for r in self.rows
                if attempt is None or r["attempt"] == attempt]


class _Cursor:
    def __init__(self, table: _Table) -> None:
        self._table = table

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def execute(self, sql, params=None):
        self._table.execute(sql, params)

    async def fetchone(self):
        return self._table.fetchone()

    async def fetchall(self):
        return self._table.fetchall()


class _Conn:
    def __init__(self, table: _Table) -> None:
        self._table = table

    def cursor(self):
        return _Cursor(self._table)

    async def commit(self):
        return None


class _Embedder:
    async def embed(self, texts):
        return [[0.1, 0.2, 0.3] for _ in texts]


class _Llm:
    def __init__(self) -> None:
        self.context = None

    async def answer(self, question, context, **kw):
        self.context = context
        return "an answer"


def _service(table: _Table) -> tuple[RagService, _Llm]:
    service = RagService.__new__(RagService)
    llm = _Llm()

    class _Ctx:
        async def __aenter__(self):
            return _Conn(table)

        async def __aexit__(self, *exc):
            return False

    service.connection = lambda user_id=None: _Ctx()  # type: ignore[assignment]
    service._pool = object()  # type: ignore[attr-defined]
    service._embedder = _Embedder()  # type: ignore[attr-defined]
    service._llm = llm  # type: ignore[attr-defined]
    service._settings = rag_settings(  # type: ignore[attr-defined]
        rag_top_k=8,
        rag_candidate_multiplier=3,
        # Held open: this file is about which generation is returned, not about
        # how near a passage has to be to survive.
        rag_max_distance=2.0,
        rag_relevance_margin=2.0,
    )
    return service, llm


def _index(service, text: str, attempt: int) -> None:
    asyncio.run(service.index(MEETING, USER, text, [], attempt))


def _retrieved(service, llm) -> str:
    """The passages the answerer was actually given, as one blob of text."""
    asyncio.run(service.answer(MEETING, "what did we decide?", USER))
    context = llm.context or []
    return " | ".join(str(part) for part in context)


# --------------------------------------------------------------------------- #
# The race
# --------------------------------------------------------------------------- #
def test_a_stale_run_cannot_replace_a_newer_generation():
    # The sequence from Phase 1.1, played out on the one piece of state that
    # phase could not reach.
    table = _Table()
    service, llm = _service(table)

    _index(service, "we agreed to move billing to Stripe", 1)
    assert "Stripe" in _retrieved(service, llm)

    # The user reprocesses; attempt 2 finishes and indexes.
    _index(service, "we agreed to stay on Braintree", 2)
    assert "Braintree" in _retrieved(service, llm)

    # Kafka redelivers attempt 1. It re-runs the whole pipeline and indexes.
    _index(service, "we agreed to move billing to Stripe", 1)

    visible = _retrieved(service, llm)
    assert "Braintree" in visible
    assert "Stripe" not in visible


def test_a_stale_run_cannot_delete_a_newer_generation():
    # The half that mattered most: before V58 the delete was unscoped, so the
    # damage was done before a single row was written back.
    table = _Table()
    service, _ = _service(table)

    _index(service, "attempt two text", 2)
    _index(service, "attempt one text", 1)

    assert "attempt two text" in table.texts(2)


def test_a_reprocess_landing_mid_index_still_wins():
    # The race the design must not depend on losing. The indexer's "is there a
    # newer generation?" probe is housekeeping, not the boundary — so this test
    # makes the reprocess land in exactly the window where that probe has
    # already said no.
    table = _Table()
    service, llm = _service(table)
    _index(service, "attempt one text", 1)

    def reprocess_lands():
        table.rows = [r for r in table.rows if r["attempt"] > 1]
        table.rows.append({
            "meeting_id": MEETING, "user_id": USER, "chunk_index": 0,
            "text": "attempt two text", "start": 0.0, "end": 1.0, "attempt": 2,
        })

    table.after_probe = reprocess_lands
    _index(service, "attempt one text", 1)

    # Attempt 1 wrote its rows anyway — it was past the check. What it could
    # not do is reach attempt 2's.
    visible = _retrieved(service, llm)
    assert "attempt two text" in visible
    assert "attempt one text" not in visible


# --------------------------------------------------------------------------- #
# Legitimate reprocessing still works
# --------------------------------------------------------------------------- #
def test_the_previous_run_stays_answerable_while_the_next_one_runs():
    # Recallix does not blank a meeting during a reprocess: the transcript, the
    # summary and the action items all stay on screen until the new run
    # replaces them. Chat matching "the meeting's current attempt" would have
    # gone silent for the length of a transcription instead, which is a
    # regression dressed as correctness.
    table = _Table()
    service, llm = _service(table)
    _index(service, "the original transcript", 1)

    # Reprocess has bumped the meeting to attempt 2. Nothing is indexed for it
    # yet, and nothing about the meeting row is consulted here.
    assert "the original transcript" in _retrieved(service, llm)


def test_the_new_run_takes_over_once_it_has_indexed():
    table = _Table()
    service, llm = _service(table)
    _index(service, "the original transcript", 1)

    _index(service, "the corrected transcript", 2)

    assert "the corrected transcript" in _retrieved(service, llm)
    assert "the original transcript" not in _retrieved(service, llm)


def test_a_run_clears_the_generations_below_it():
    # Otherwise every reprocess leaves a full set of 1536-dimension vectors
    # behind for ever.
    table = _Table()
    service, _ = _service(table)

    _index(service, "one", 1)
    _index(service, "two", 2)
    _index(service, "three", 3)

    assert table.generations() == {3}


def test_a_repeat_of_the_current_run_replaces_itself():
    # A duplicate delivery of the run that *is* current, which is the ordinary
    # at-least-once case and must not double the chunks.
    table = _Table()
    service, _ = _service(table)

    _index(service, "same text", 2)
    _index(service, "same text", 2)

    assert len(table.rows) == 1
    assert table.generations() == {2}


def test_an_edit_re_indexed_under_the_current_run_is_what_chat_answers_from():
    # The transcript-edit path posts to /ai/index with the meeting's current
    # attempt. Filed under an older one it would be invisible, and chat would
    # keep answering with the name the user had just corrected.
    table = _Table()
    service, llm = _service(table)
    _index(service, "Priya said the deadline is Friday", 2)

    _index(service, "Priyanka said the deadline is Friday", 2)

    assert "Priyanka" in _retrieved(service, llm)


# --------------------------------------------------------------------------- #
# The statements themselves
# --------------------------------------------------------------------------- #
def test_the_delete_is_scoped_to_the_generation():
    table = _Table()
    service, _ = _service(table)
    _index(service, "text", 3)

    delete = next(s for s in table.log if "DELETE FROM transcript_chunks" in s)
    assert "processing_attempt <= %s" in " ".join(delete.split())


def test_every_read_asks_for_the_newest_generation_only():
    table = _Table()
    service, llm = _service(table)
    _index(service, "text", 1)
    _retrieved(service, llm)

    reads = [s for s in table.log if "FROM transcript_chunks c" in s]
    assert reads, "no retrieval query ran"
    for sql in reads:
        flat = " ".join(sql.split())
        assert "newer.processing_attempt > c.processing_attempt" in flat, flat


def test_the_generation_is_stored_on_every_chunk():
    table = _Table()
    service, _ = _service(table)

    _index(service, "a sentence. another sentence. a third one.", 7)

    assert table.rows
    assert all(r["attempt"] == 7 for r in table.rows)
