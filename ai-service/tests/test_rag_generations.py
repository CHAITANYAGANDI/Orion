"""Embedded chunks belong to a processing run, and a stale run cannot touch them.

pgvector is the one piece of a meeting's derived state Spring does not write.
The worker indexes it directly, while the pipeline is running — minutes before
the result callback exists — so the stale-attempt check inside `applyResult`
never gets a chance to protect it. A redelivered attempt-1 execution ran a blind
`DELETE FROM transcript_chunks WHERE meeting_id = ?` and put the old transcript
back. Its result callback was then rejected as stale, correctly and far too
late: the meeting's page showed the new transcript and "ask this meeting"
answered from the one the user had asked to be replaced.

Two things stop it, and they answer different questions.

* **The generation on the row (V58)** stops a delete reaching a *newer* run's
  chunks. Its scope is `processing_attempt <= N`; there is simply no statement
  in the indexer that reaches above N.
* **The lock on the meeting row** stops a delete reaching the *current* run's
  chunks when no newer generation exists yet — the whole window between pressing
  reprocess and the new run finishing, during which generation 1 is not a
  superseded copy of anything, it is what the user is chatting with.

The first without the second was the gap: scoping the delete protected nothing
when there was only one generation to protect.

`_Table` below is a small interpreter for the statements the indexer and
retrieval actually issue. It reads the predicates out of the SQL rather than
assuming them, so dropping `AND processing_attempt <= %s` from the delete, the
newest-generation filter from a query, or `FOR NO KEY UPDATE` from the lock
makes these tests fail by doing what the real database would.
"""

from __future__ import annotations

import asyncio

from app.rag import RagService
from tests.conftest import rag_settings


MEETING = "mtg_1"
USER = "usr_1"


class _Table:
    """transcript_chunks and one meetings row, as far as these statements care."""

    def __init__(self) -> None:
        self.rows: list[dict] = []
        self.log: list[str] = []
        #: `meetings.processing_attempt` — the run the meeting is on now, which
        #: is a different question from which generations have been indexed.
        self.meeting_attempt = 1
        #: Called while the meeting row is held. Whatever it does happens
        #: *after* the indexer has read the attempt — which is what the lock
        #: guarantees in Postgres: a reprocess arriving now waits for the
        #: commit rather than changing an answer already given.
        self.while_locked = None
        #: Every attempt the indexer was told the meeting was on, in order.
        self.reads: list[int] = []

    # --- statement dispatch ------------------------------------------------- #
    def execute(self, sql: str, params):
        self.log.append(sql)
        flat = " ".join(sql.split())

        if flat.startswith("SELECT processing_attempt FROM meetings"):
            return self._lock_meeting(flat, params)
        if flat.startswith("DELETE FROM transcript_chunks"):
            return self._delete(flat, params)
        if flat.startswith("INSERT INTO transcript_chunks"):
            return self._insert(params)
        if "FROM transcript_chunks c" in flat:
            return self._select(flat, params)
        raise AssertionError(f"unrecognised statement: {flat[:120]}")

    def _lock_meeting(self, flat, params):
        # It has to take the row, not glance at it. A plain SELECT would leave a
        # gap between believing this run is current and acting on it, and the
        # reprocess is one UPDATE away at all times.
        assert "FOR NO KEY UPDATE" in flat, flat
        (meeting_id,) = params
        if meeting_id != MEETING:
            self._result = []
            return
        self.reads.append(self.meeting_attempt)
        self._result = [(self.meeting_attempt,)]
        # Anything the reprocess does from here is queued behind this
        # transaction in the real database, so it cannot alter what was read.
        if self.while_locked is not None:
            hook, self.while_locked = self.while_locked, None
            hook()

    def _delete(self, flat, params):
        # Read the scope out of the statement. A delete that has lost its
        # generation predicate really does remove every generation here, which
        # is one of the two regressions these tests exist to catch.
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
        self.rows.append({
            "meeting_id": params[1],
            "user_id": params[2],
            "chunk_index": params[3],
            "text": params[4],
            "start": params[5],
            "end": params[6],
            "attempt": params[8] if len(params) > 8 else 1,
        })
        self._result = []

    def _select(self, flat, params):
        _vec, meeting_id, limit = params
        rows = [r for r in self.rows if r["meeting_id"] == meeting_id]
        if "NOT EXISTS" in flat:
            newest = max((r["attempt"] for r in rows), default=0)
            rows = [r for r in rows if r["attempt"] == newest]
        self._result = [
            (r["chunk_index"], r["text"], r["start"], r["end"], 0.4) for r in rows
        ][:limit]

    # --- what the caller sees ----------------------------------------------- #
    def fetchone(self):
        return self._result[0] if self._result else None

    def fetchall(self):
        return self._result

    def reprocess(self) -> None:
        """What Spring's reprocess() does to the row the indexer coordinates on."""
        self.meeting_attempt += 1

    def erase_transcript(self) -> None:
        """What Spring's eraseTranscript() does, in one transaction.

        It takes the meeting row first -- the same row, at the same strength, so
        the two never interleave -- deletes the chunks, and moves the attempt on
        so that anything already in flight is stale by the check it already
        makes.
        """
        self.rows = [r for r in self.rows if r["meeting_id"] != MEETING]
        self.meeting_attempt += 1

    def generations(self) -> set[int]:
        return {r["attempt"] for r in self.rows}

    def texts(self, attempt: int | None = None) -> list[str]:
        return [r["text"] for r in self.rows if attempt is None or r["attempt"] == attempt]


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


def _run(service, table, text: str, attempt: int = 1) -> None:
    """The meeting is on this run, and this run indexes. The ordinary case."""
    table.meeting_attempt = attempt
    asyncio.run(service.index(MEETING, USER, text, [], attempt))


def _stale(service, text: str, attempt: int) -> None:
    """A redelivered execution of an older run, indexing again.

    The meeting's attempt is deliberately left where it is: that is the whole
    situation being tested.
    """
    asyncio.run(service.index(MEETING, USER, text, [], attempt))


def _retrieved(service, llm) -> str:
    """The passages the answerer was actually given, as one blob of text."""
    asyncio.run(service.answer(MEETING, "what did we decide?", USER))
    return " | ".join(str(part) for part in (llm.context or []))


# --------------------------------------------------------------------------- #
# The generation a reprocess left readable, with nothing newer yet
# --------------------------------------------------------------------------- #
def test_a_stale_run_cannot_rewrite_the_only_generation_there_is():
    """The gap the generation column alone did not close.

    Scoping the delete to `processing_attempt <= N` stops an old run reaching a
    *newer* generation. It does nothing when there is no newer generation — the
    whole window between pressing reprocess and the new run finishing — and in
    that window generation 1 is what the user is chatting with.
    """
    table = _Table()
    service, llm = _service(table)
    _run(service, table, "the original transcript", 1)

    # The user presses reprocess. Attempt 2 is current and has indexed nothing.
    table.reprocess()
    assert table.meeting_attempt == 2
    assert table.generations() == {1}

    # Kafka redelivers attempt 1, which re-runs and re-indexes.
    _stale(service, "a redelivered transcript", 1)

    assert table.texts(1) == ["the original transcript"]
    assert "the original transcript" in _retrieved(service, llm)
    assert "a redelivered" not in _retrieved(service, llm)


def test_a_stale_run_does_not_even_delete_the_readable_generation():
    # The half that would have been silent: between the delete and the insert
    # the meeting had no chunks at all, and a stale run that died in there left
    # it unsearchable until somebody reprocessed it again.
    table = _Table()
    service, _ = _service(table)
    _run(service, table, "the original transcript", 1)
    table.reprocess()

    _stale(service, "a redelivered transcript", 1)

    assert len(table.rows) == 1
    assert table.rows[0]["text"] == "the original transcript"


def test_an_edit_made_during_the_first_run_survives_a_redelivery():
    # Why "the content would be the same anyway" is not an answer. A correction
    # typed at attempt 1 is written into generation 1 by /ai/index; a
    # redelivered attempt-1 pipeline would put the provider's original wording
    # back over it.
    table = _Table()
    service, llm = _service(table)
    _run(service, table, "Priya said the deadline is Friday", 1)
    _run(service, table, "Priyanka said the deadline is Friday", 1)   # the edit
    table.reprocess()

    _stale(service, "Priya said the deadline is Friday", 1)           # the redelivery

    assert "Priyanka" in _retrieved(service, llm)


def test_the_meeting_row_is_taken_before_anything_is_deleted():
    # Ordering, because a delete issued first is a delete that has already
    # happened by the time the answer comes back.
    table = _Table()
    service, _ = _service(table)
    _run(service, table, "text", 1)

    kinds = [" ".join(s.split()) for s in table.log]
    lock = next(i for i, k in enumerate(kinds)
                if k.startswith("SELECT processing_attempt FROM meetings"))
    delete = next(i for i, k in enumerate(kinds)
                  if k.startswith("DELETE FROM transcript_chunks"))
    assert lock < delete


def test_a_meeting_that_is_gone_is_not_indexed():
    # Deleted mid-run, or belonging to somebody else — row-level security
    # answers the second by returning nothing rather than by raising.
    table = _Table()
    service, _ = _service(table)
    asyncio.run(service.index("mtg_vanished", USER, "some text", [], 1))

    assert table.rows == []


# --------------------------------------------------------------------------- #
# The two orders, and why both are correct
# --------------------------------------------------------------------------- #
def test_a_reprocess_that_got_there_first_makes_the_index_a_no_op():
    # The reprocess commits, then the indexer takes the row and reads a number
    # that is not its own.
    table = _Table()
    service, _ = _service(table)
    _run(service, table, "attempt one text", 1)
    table.reprocess()

    _stale(service, "a redelivered attempt one", 1)

    assert table.reads[-1] == 2
    assert table.texts() == ["attempt one text"]


def test_a_reprocess_arriving_after_the_row_is_taken_does_not_change_the_answer():
    # The other order. The indexer holds the row, so the reprocess is waiting on
    # this commit, and the attempt it read is still the truth it acted on: this
    # run really was current at the moment it wrote.
    table = _Table()
    service, _ = _service(table)
    _run(service, table, "attempt one text", 1)

    table.while_locked = table.reprocess
    _run(service, table, "a legitimate rewrite of attempt one", 1)

    assert table.reads[-1] == 1
    assert table.texts(1) == ["a legitimate rewrite of attempt one"]


def test_a_run_ahead_of_the_meeting_is_refused_too():
    # Should not happen: the number reaches the worker from the row. If it ever
    # does, believing it would write a generation nothing can supersede.
    table = _Table()
    service, _ = _service(table)
    _run(service, table, "attempt one text", 1)

    _stale(service, "from the future", 5)

    assert table.generations() == {1}
    assert table.texts() == ["attempt one text"]


# --------------------------------------------------------------------------- #
# Erased transcripts stay erased
# --------------------------------------------------------------------------- #
def test_a_run_that_started_before_an_erasure_cannot_put_the_chunks_back():
    # The resurrection the attempt check did not cover on its own: erasure does
    # not look like a reprocess, so without moving the attempt this run would
    # have woken up, found its own number still current, and written the
    # embeddings of a transcript the account holder had deleted back into the
    # table that chat reads.
    table = _Table()
    service, llm = _service(table)
    _run(service, table, "the words somebody asked us to delete", 1)

    table.erase_transcript()

    _stale(service, "the words somebody asked us to delete", 1)

    assert table.rows == []
    assert "asked us to delete" not in _retrieved(service, llm)


def test_an_index_that_won_the_race_is_still_erased_afterwards():
    # The other order. The indexer got the meeting row first, so erasure waited
    # for its commit -- and then deleted what it had just written. Both orders
    # converge on erased.
    table = _Table()
    service, _ = _service(table)
    _run(service, table, "the words somebody asked us to delete", 1)

    table.erase_transcript()

    assert table.rows == []


def test_erasure_does_not_stop_a_later_reprocess_indexing():
    # Erasing the transcript leaves the recording, so the meeting can be run
    # again. The bump makes older runs stale; it must not make future ones so.
    table = _Table()
    service, llm = _service(table)
    _run(service, table, "the original transcript", 1)
    table.erase_transcript()          # meeting is now on attempt 2

    _run(service, table, "a freshly transcribed version", 2)

    assert "a freshly transcribed version" in _retrieved(service, llm)


# --------------------------------------------------------------------------- #
# A newer generation is still protected
# --------------------------------------------------------------------------- #
def test_a_stale_run_cannot_replace_a_newer_generation():
    table = _Table()
    service, llm = _service(table)

    _run(service, table, "we agreed to move billing to Stripe", 1)
    assert "Stripe" in _retrieved(service, llm)

    _run(service, table, "we agreed to stay on Braintree", 2)
    assert "Braintree" in _retrieved(service, llm)

    _stale(service, "we agreed to move billing to Stripe", 1)

    visible = _retrieved(service, llm)
    assert "Braintree" in visible
    assert "Stripe" not in visible


def test_a_stale_run_cannot_delete_a_newer_generation():
    table = _Table()
    service, _ = _service(table)

    _run(service, table, "attempt two text", 2)
    _stale(service, "attempt one text", 1)

    assert "attempt two text" in table.texts(2)


# --------------------------------------------------------------------------- #
# Legitimate reprocessing still works
# --------------------------------------------------------------------------- #
def test_the_previous_run_stays_answerable_while_the_next_one_runs():
    # Reverie does not blank a meeting during a reprocess: the transcript, the
    # summary and the action items all stay on screen until the new run
    # replaces them. Chat matching "the meeting's current attempt" would have
    # gone silent for the length of a transcription instead — a regression
    # dressed as correctness.
    table = _Table()
    service, llm = _service(table)
    _run(service, table, "the original transcript", 1)
    table.reprocess()

    assert "the original transcript" in _retrieved(service, llm)


def test_the_new_run_takes_over_once_it_has_indexed():
    table = _Table()
    service, llm = _service(table)
    _run(service, table, "the original transcript", 1)

    _run(service, table, "the corrected transcript", 2)

    assert "the corrected transcript" in _retrieved(service, llm)
    assert "the original transcript" not in _retrieved(service, llm)


def test_a_run_clears_the_generations_below_it():
    # Otherwise every reprocess leaves a full set of 1536-dimension vectors
    # behind for ever.
    table = _Table()
    service, _ = _service(table)

    _run(service, table, "one", 1)
    _run(service, table, "two", 2)
    _run(service, table, "three", 3)

    assert table.generations() == {3}


def test_a_repeat_of_the_current_run_replaces_itself():
    # A duplicate delivery of the run that *is* current — the ordinary
    # at-least-once case, which must not double the chunks.
    table = _Table()
    service, _ = _service(table)

    _run(service, table, "same text", 2)
    _run(service, table, "same text", 2)

    assert len(table.rows) == 1
    assert table.generations() == {2}


def test_an_edit_re_indexed_under_the_current_run_is_what_chat_answers_from():
    # The transcript-edit path posts to /ai/index with the meeting's current
    # attempt. Filed under an older one it would be invisible, and chat would
    # keep answering with the name the user had just corrected.
    table = _Table()
    service, llm = _service(table)
    _run(service, table, "Priya said the deadline is Friday", 2)

    _run(service, table, "Priyanka said the deadline is Friday", 2)

    assert "Priyanka" in _retrieved(service, llm)


# --------------------------------------------------------------------------- #
# The statements themselves
# --------------------------------------------------------------------------- #
def test_the_delete_is_scoped_to_the_generation():
    table = _Table()
    service, _ = _service(table)
    _run(service, table, "text", 3)

    delete = next(s for s in table.log if "DELETE FROM transcript_chunks" in s)
    assert "processing_attempt <= %s" in " ".join(delete.split())


def test_every_read_asks_for_the_newest_generation_only():
    table = _Table()
    service, llm = _service(table)
    _run(service, table, "text", 1)
    _retrieved(service, llm)

    reads = [s for s in table.log if "FROM transcript_chunks c" in s]
    assert reads, "no retrieval query ran"
    for sql in reads:
        flat = " ".join(sql.split())
        assert "newer.processing_attempt > c.processing_attempt" in flat, flat


def test_the_generation_is_stored_on_every_chunk():
    table = _Table()
    service, _ = _service(table)

    _run(service, table, "a sentence. another sentence. a third one.", 7)

    assert table.rows
    assert all(r["attempt"] == 7 for r in table.rows)


def test_nothing_slow_happens_under_the_lock():
    # The embedding call is a network round trip to the model. Held under the
    # meeting row it would block every reprocess, rename and status callback for
    # that meeting for as long as the provider took.
    table = _Table()
    service, _ = _service(table)
    embedded_at: list[int] = []

    class _WatchingEmbedder:
        async def embed(self, texts):
            embedded_at.append(len(table.log))
            return [[0.1, 0.2, 0.3] for _ in texts]

    service._embedder = _WatchingEmbedder()  # type: ignore[attr-defined]
    _run(service, table, "text", 1)

    # Nothing had been issued to the database when the embedder was called.
    assert embedded_at == [0]
