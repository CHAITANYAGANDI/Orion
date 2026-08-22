"""RAG service: chunk + embed transcripts into pgvector, retrieve, and answer.

Owns the transcript_chunks table directly (async psycopg). Vectors are passed
as `::vector` string casts, so no pgvector Python adapter is required. When
PG_HOST is unset the service disables itself gracefully (chat returns a friendly
message) so the app still boots.
"""

from __future__ import annotations

import logging
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from app import retrieval
from app.answering import Answer
from app.config import Settings
from app.providers.ports import EmbeddingPort, LlmPort
from app.questions import (
    classify,
    could_name_a_meeting,
    named_person,
    names_meeting,
    spans_meetings,
    wants_enumeration,
    wants_full_list,
)
from app.retrieval import Candidate, RetrievalReport
from app.schemas import Segment
from app.suggestions import MAX_MEETINGS, MAX_OPEN_ITEMS, workspace_material
from app.timeframe import detect_window

logger = logging.getLogger("ai-service.rag")


def _vec_literal(embedding: list[float]) -> str:
    """Encode a vector as a pgvector text literal: '[0.1,0.2,...]'."""
    return "[" + ",".join(f"{x:.6f}" for x in embedding) + "]"


def _history_floor(history_days: int | None) -> datetime | None:
    """The oldest meeting the workspace chat may read, or None for no floor.

    A scope control rather than a privacy boundary: nothing is hidden, deleted
    or made unreadable, and the meeting's own page still answers about it. Its
    value is in the other direction — a workspace with three years of standups
    answers "what did we decide about pricing" better when it is not competing
    with a decision that was reversed eighteen months ago.
    """
    if history_days is None or history_days <= 0:
        return None
    return datetime.now(timezone.utc) - timedelta(days=history_days)


def _as_answer(result) -> Answer:
    """Whatever the LLM port returned, as an Answer.

    The port returns one now, but a fake in a test and an older adapter both
    return a bare string. An unknown `used` means the caller falls back to
    citing everything it retained, which is exactly what citations were before
    the field existed — no worse, and never a claim that a passage was used
    when it is known it was not.
    """
    if isinstance(result, Answer):
        return result
    return Answer(text=str(result))


def _cited(origins: list, used: tuple[int, ...]) -> list[Candidate]:
    """The passages the model said it relied on.

    Takes an origin list the same length as the prompt's numbered passages, with
    None wherever a line is not a transcript chunk. That is not fussiness: the
    action-item ledger, the decision record and the "--- from last week ---"
    separators are all numbered passages the model can cite, so a model citing
    [2] when the first four entries are ledger lines is not citing the second
    chunk. Computing this as an offset works right up to the windowed comparison
    path, where passages and separators interleave — and getting it wrong
    attaches a citation to the wrong moment of the wrong meeting, which is worse
    than attaching none at all.

    An empty `used` means the model did not say, and everything retained is
    returned. The filter upstream has already discarded what was irrelevant, so
    that fallback is now a far smaller claim than it used to be.
    """
    chunks = [o for o in origins if isinstance(o, Candidate)]
    if not used:
        return chunks
    picked = [
        origins[i - 1]
        for i in used
        if 1 <= i <= len(origins) and isinstance(origins[i - 1], Candidate)
    ]
    return picked or chunks


def _passage_of(c: "Candidate") -> str:
    """One retrieved chunk, labelled with its meeting and date.

    The date is what lets the model say which of two contradictory statements
    came later. Without it, "we decided X" and "we decided not-X" are two
    equally-present facts and the answer picks one arbitrarily.
    """
    when = c.created_at.date().isoformat() if isinstance(c.created_at, datetime) else ""
    stamp = f" · {when}" if when else ""
    return f"[Meeting: {c.meeting_title}{stamp}] {c.text}"


class RagService:
    """Transcript indexing + grounded question answering over pgvector."""

    def __init__(self, settings: Settings, embedder: EmbeddingPort, llm: LlmPort) -> None:
        self._settings = settings
        self._embedder = embedder
        self._llm = llm
        self._pool = None  # type: ignore[var-annotated]

    # --- lifecycle ---------------------------------------------------------- #
    async def start(self) -> None:
        if not self._settings.pg_host:
            logger.warning("PG_HOST not set — RAG chat disabled.")
            return
        from psycopg_pool import AsyncConnectionPool

        conninfo = (
            f"host={self._settings.pg_host} port={self._settings.pg_port} "
            f"dbname={self._settings.pg_database} user={self._settings.pg_user} "
            f"password={self._settings.pg_password} "
            f"sslmode={self._settings.pg_sslmode}"
        )
        self._pool = AsyncConnectionPool(conninfo, min_size=1, max_size=5, open=False)
        try:
            await self._pool.open(wait=True, timeout=15)
            logger.info("RAG connected to Postgres at %s.", self._settings.pg_host)
        except Exception as exc:  # noqa: BLE001 — degrade rather than crash.
            logger.warning("RAG could not open Postgres pool: %s", exc)
            self._pool = None

    async def stop(self) -> None:
        if self._pool is not None:
            try:
                await self._pool.close()
            except Exception:  # noqa: BLE001
                pass

    @property
    def enabled(self) -> bool:
        return self._pool is not None

    @property
    def pool(self):  # type: ignore[no-untyped-def]
        """The shared Postgres pool, or None when RAG is disabled.

        Exposed so sibling services (e.g. MemoryService) reuse this pool rather
        than opening a second one against the same database.
        """
        return self._pool

    @asynccontextmanager
    async def connection(self, user_id: str | None = None):
        """A pooled connection with its tenant stamped on it.

        Every table this service touches is under row-level security, so a
        connection without `app.user_id` set reads nothing at all. That is the
        intended failure: a query that forgets its tenant returns empty rather
        than returning somebody else's meeting.

        The tenant is written on each checkout, never conditionally, because the
        pool hands the same connection to the next caller — anything left behind
        would be inherited.

        There is deliberately no bypass. This service connects as the
        unprivileged role, so nothing it can execute will lift the restriction:
        every query here is confined to one user.
        """
        async with self._pool.connection() as conn:  # type: ignore[union-attr]
            await conn.execute(
                "SELECT set_config('app.user_id', %s, false)", (user_id or "",)
            )
            yield conn

    # --- indexing ----------------------------------------------------------- #
    async def index(
        self,
        meeting_id: str,
        user_id: str | None,
        transcript: str,
        segments: list[Segment],
    ) -> None:
        """Chunk, embed and store one meeting's transcript.

        `user_id` is denormalised onto every row so workspace-wide retrieval can
        filter by owner without joining `meetings`.

        It is now required. There used to be a fallback that resolved the owner
        from the meeting row, but under row-level security that read needs a
        privilege this service deliberately does not have — and granting it
        would have handed the whole indexing path an escape from tenant
        isolation to cover an event shape that no longer occurs. Skipping is the
        safe failure: the meeting simply is not searchable until reprocessed.
        """
        if not self.enabled:
            return
        if not user_id:
            logger.warning(
                "No user_id for meeting %s; skipping indexing rather than "
                "reading across tenants to find one.", meeting_id
            )
            return
        chunks = self._chunk(transcript, segments)
        if not chunks:
            return
        embeddings = await self._embedder.embed([c["text"] for c in chunks])
        try:
            async with self.connection(user_id) as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "DELETE FROM transcript_chunks WHERE meeting_id = %s", (meeting_id,)
                    )
                    for i, (chunk, emb) in enumerate(zip(chunks, embeddings)):
                        await cur.execute(
                            """
                            INSERT INTO transcript_chunks
                                (id, meeting_id, user_id, chunk_index, text,
                                 start_time, end_time, embedding)
                            VALUES (%s, %s, %s, %s, %s, %s, %s, %s::vector)
                            """,
                            (
                                "chk_" + uuid.uuid4().hex,
                                meeting_id,
                                user_id,
                                i,
                                chunk["text"],
                                chunk["start"],
                                chunk["end"],
                                _vec_literal(emb),
                            ),
                        )
                await conn.commit()
            logger.info("Indexed %d transcript chunks for meeting %s.", len(chunks), meeting_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("RAG indexing failed for %s: %s", meeting_id, exc)

    # --- retrieval + answer ------------------------------------------------- #
    async def answer(
        self,
        meeting_id: str,
        question: str,
        user_id: str | None = None,
        mode: str = "express",
        history: list[str] | None = None,
    ) -> tuple[str, list[dict]]:
        """Answer a question about one meeting.

        `user_id` is what row-level security checks. Spring has already verified
        ownership before calling, but passing the owner means a bug there cannot
        turn into a cross-tenant read: the database independently refuses.

        `mode` is the same choice the workspace chat offers, and it differs in
        the same two ways: how many passages retrieval returns, and whether the
        answer is asked to enumerate rather than summarise.

        It used to be absent here, on the recorded ground that one meeting was
        retrieved in full either way. That was not true. Retrieval takes the
        `rag_top_k` nearest passages and a fifteen-minute recording already
        chunks to more than that, so anything of length was answered from a
        sample of itself -- and which part of the sample depended on the
        question's embedding, which is the version of this bug nobody notices,
        because a partial answer still reads like a whole one.
        """
        if not self.enabled:
            return ("RAG chat is not configured on this deployment.", [])

        deep = mode == "advanced"
        intent = classify(question)
        top_k = self._settings.rag_deep_top_k if deep else self._settings.rag_top_k
        # Over-retrieve, then filter. Filtering can only discard, so a scan that
        # returns exactly the final budget arrives with nothing to spare.
        candidates = top_k * self._settings.rag_candidate_multiplier
        q_emb = (await self._embedder.embed([question]))[0]
        try:
            async with self.connection(user_id) as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        """
                        SELECT chunk_index, text, start_time, end_time,
                               embedding <=> %s::vector AS distance
                        FROM transcript_chunks
                        WHERE meeting_id = %s
                        ORDER BY distance
                        LIMIT %s
                        """,
                        (_vec_literal(q_emb), meeting_id, candidates),
                    )
                    rows = await cur.fetchall()
        except Exception as exc:  # noqa: BLE001
            logger.warning("RAG retrieval failed for %s: %s", meeting_id, exc)
            return ("I couldn't search this meeting's transcript right now.", [])

        if not rows:
            return ("I don't have an indexed transcript for this meeting yet.", [])

        report = RetrievalReport(mode="advanced" if deep else "express", intent=intent)
        # A question naming a speaker should be answered from what that speaker
        # said. The names are already in the transcript text, so this is a score
        # nudge rather than a second index -- and a nudge cannot manufacture
        # evidence, because a boosted passage still had to clear the filter.
        person = named_person(question)
        kept = retrieval.select(
            rows,
            question,
            limit=top_k,
            max_distance=self._settings.rag_max_distance,
            margin=self._settings.rag_relevance_margin,
            minimum=self._settings.rag_min_passages,
            lexical_weight=self._settings.rag_lexical_weight,
            duplicate_similarity=self._settings.rag_duplicate_similarity,
            # One meeting, so there is no crowding to prevent: capping here
            # would cap the answer.
            per_meeting_cap=0,
            workspace=False,
            boost_terms=retrieval.tokens(person) if person else None,
            boost=self._settings.rag_name_boost,
            report=report,
        )
        if not kept:
            self._log_retrieval(report)
            return ("I couldn't find this in this meeting's transcript.", [])

        context = [c.text for c in kept]
        report.context_chars = sum(len(c) for c in context)
        # Enumeration follows the *question*, not the mode. Advanced used to
        # force it on everything, so "what does JWT mean here?" came back as one
        # bullet and the line "Total: 1." Advanced means look deeper, not
        # convert the answer into an inventory.
        answer = _as_answer(
            await self._llm.answer(
                question,
                context,
                exhaustive=wants_enumeration(intent) or wants_full_list(question),
                intent=intent,
                depth="advanced" if deep else "express",
                history=history,
            )
        )
        cited = _cited(list(kept), answer.used)
        report.used = len(cited)
        self._log_retrieval(report)
        citations = [
            {"chunkIndex": c.chunk_index, "start": c.start, "end": c.end, "text": c.text}
            for c in cited
        ]
        return (answer.text, citations)

    def _log_retrieval(self, report: RetrievalReport) -> None:
        """Counts, at debug level, and never a word of transcript.

        This is how the two modes are shown to be genuinely different rather
        than differently labelled — see `scripts/compare_modes.py`, which prints
        the same numbers side by side. It carries no passage text, no question
        and no meeting title on purpose: these lines land in log aggregators,
        and a transcript must not.
        """
        logger.debug("retrieval %s", report.as_dict())

    # --- the commitment ledger ---------------------------------------------- #
    # How many action items to put in front of the model. Enough to cover a
    # normal workspace, bounded because these compete with retrieved passages
    # for the context window — a user with a thousand stale items must not
    # crowd out the transcript evidence that answers everything else.
    _MAX_COMMITMENTS = 60

    async def _commitment_context(
        self, user_id: str, meeting_ids: list[str] | None = None
    ) -> list[str]:
        """Every tracked action item, with the status the transcript cannot know.

        Ordered outstanding-first and then by due date, so the truncation above
        drops finished work rather than live work — the opposite order would
        quietly hide exactly what "what hasn't been completed?" is asking for.

        Completed items are included rather than filtered out, deliberately. A
        list of only the open ones lets the model infer that anything it
        remembers from the transcript and cannot see here is still outstanding,
        which is the same wrong answer by a longer route. Seeing "DONE" is what
        stops it.

        Never raises: this is an enrichment. If the tracker cannot be read the
        answer degrades to transcript-only, which is what it was before.
        """
        sql = """
            SELECT a.title, a.status, a.owner_name, a.due_date, m.title
              FROM meeting_action_items a
              JOIN meetings m ON m.id = a.meeting_id
             WHERE m.user_id = %s
        """
        params: list = [user_id]
        if meeting_ids:
            sql += " AND a.meeting_id = ANY(%s)"
            params.append(list(meeting_ids))
        # 'DONE' sorts after 'IN_PROGRESS' and 'OPEN' alphabetically, which is
        # the order wanted here; spelled out rather than relied upon.
        sql += """
             ORDER BY CASE a.status WHEN 'DONE' THEN 1 ELSE 0 END,
                      a.due_date NULLS LAST,
                      a.created_at
             LIMIT %s
        """
        params.append(self._MAX_COMMITMENTS)

        try:
            async with self.connection(user_id) as conn:
                async with conn.cursor() as cur:
                    await cur.execute(sql, tuple(params))
                    rows = await cur.fetchall()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not read action items for user %s: %s", user_id, exc)
            return []

        if not rows:
            return []

        lines = []
        for title, status, owner, due, meeting in rows:
            parts = [f"[Action item · {status or 'OPEN'} · {meeting}] {title}"]
            if owner:
                parts.append(f"owner: {owner}")
            if due:
                parts.append(f"due: {due}")
            lines.append(" — ".join(parts))

        # A header, because without one these read as more transcript and the
        # model quotes them back as things somebody said in a meeting.
        return [
            "The following are tracked action items and their CURRENT status, "
            "which is more up to date than anything in the transcripts below. "
            "Treat DONE as completed even if a transcript says otherwise.",
            *lines,
        ]

    # --- the decision record -------------------------------------------------- #
    # Bounded for the same reason as the commitments above: these compete with
    # retrieved passages for the context window. Chronological rather than
    # relevance-ordered, so what survives the limit is a continuous recent
    # history — a sampled one would show a conflict's later half without its
    # earlier half and make a settled question look freshly decided.
    _MAX_DECISIONS = 80

    async def _decision_context(
        self, user_id: str, meeting_ids: list[str] | None = None
    ) -> list[str]:
        """Every decision on record, oldest first, each with its date.

        Order is the whole point. "Do any decisions conflict with earlier ones?"
        is a question about sequence, and a model given an unordered, undated
        list will report a conflict without being able to say which side of it
        is current — which is worse than not answering, because the reader
        cannot tell either.

        Risks are excluded: a risk that recurs is not a contradiction, so
        including them would produce "conflicts" out of a team consistently
        worrying about the same dependency.

        Never raises, for the same reason as the commitment ledger — this is an
        enrichment, and losing it should cost one question rather than all of
        them.
        """
        sql = """
            SELECT i.text, m.title, m.created_at
              FROM meeting_insights i
              JOIN meetings m ON m.id = i.meeting_id
             WHERE m.user_id = %s AND i.kind = 'DECISION'
        """
        params: list = [user_id]
        if meeting_ids:
            sql += " AND i.meeting_id = ANY(%s)"
            params.append(list(meeting_ids))
        sql += " ORDER BY m.created_at, i.created_at LIMIT %s"
        params.append(self._MAX_DECISIONS)

        try:
            async with self.connection(user_id) as conn:
                async with conn.cursor() as cur:
                    await cur.execute(sql, tuple(params))
                    rows = await cur.fetchall()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not read decisions for user %s: %s", user_id, exc)
            return []

        if not rows:
            return []

        lines = []
        for text, meeting, created in rows:
            when = created.date().isoformat() if isinstance(created, datetime) else "unknown date"
            lines.append(f"[Decision · {when} · {meeting}] {text}")

        return [
            "The following are the decisions on record across these meetings, "
            "oldest first. A later decision that contradicts an earlier one "
            "supersedes it — say which is current when you report a conflict.",
            *lines,
        ]

    async def workspace_signals(self, user_id: str) -> dict:
        """Facts about the workspace that justify a question being offered.

        Counts only, and cheap ones. This exists because Home's chips were being
        generated entirely from whichever twelve meetings were most recent,
        which is how "Competitive messaging framework?" became somebody's entry
        point into an archive of fifty unrelated calls. A question backed by
        "you have four things overdue" is about the workspace; a question backed
        by one summary is about one meeting.

        `recurring` is a folder with more than one recent meeting in it — the
        one signal available here that says several meetings are about the same
        work without reading any of them. Never raises: no signals means the
        generated questions and the static floor carry the row, which is what
        happened before this existed.
        """
        if not self.enabled:
            return {}

        sql = """
            SELECT
              (SELECT count(*) FROM meeting_action_items a
                 JOIN meetings m ON m.id = a.meeting_id
                WHERE m.user_id = %(u)s AND a.status <> 'DONE') AS open_items,
              (SELECT count(*) FROM meeting_action_items a
                 JOIN meetings m ON m.id = a.meeting_id
                WHERE m.user_id = %(u)s AND a.status <> 'DONE'
                  AND a.due_date IS NOT NULL AND a.due_date < CURRENT_DATE) AS overdue,
              (SELECT count(*) FROM meeting_insights i
                 JOIN meetings m ON m.id = i.meeting_id
                WHERE m.user_id = %(u)s AND i.kind = 'DECISION') AS decisions
        """
        recurring_sql = """
            SELECT p.name, count(*) AS n
              FROM meetings m JOIN projects p ON p.id = m.project_id
             WHERE m.user_id = %s AND m.status = 'READY'
             GROUP BY p.name HAVING count(*) > 1
             ORDER BY n DESC, max(m.created_at) DESC
             LIMIT 1
        """
        try:
            async with self.connection(user_id) as conn:
                async with conn.cursor() as cur:
                    await cur.execute(sql, {"u": user_id})
                    row = await cur.fetchone()
                    await cur.execute(recurring_sql, (user_id,))
                    top = await cur.fetchone()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not read workspace signals for %s: %s", user_id, exc)
            return {}

        return {
            "open_items": int(row[0] or 0) if row else 0,
            "overdue": int(row[1] or 0) if row else 0,
            "decisions": int(row[2] or 0) if row else 0,
            "recurring": top[0] if top else None,
        }

    async def workspace_material(
        self, user_id: str, meeting_ids: list[str] | None = None
    ) -> str:
        """Recent meetings and outstanding work, rendered for the suggester.

        Read here rather than assembled in Spring and posted over, matching
        workspace chat: the caller sends a user id and this service does the
        reading. Two services querying the same tables for the same purpose is
        how the two drift.

        Returns an empty string for a user with no processed meetings, which
        tells the caller to skip the model call rather than ask for questions
        about an empty archive.
        """
        if not self.enabled:
            return ""

        meetings_sql = """
            SELECT m.title, m.created_at, s.short_summary
              FROM meetings m
              LEFT JOIN LATERAL (
                    SELECT short_summary
                      FROM meeting_summaries
                     WHERE meeting_id = m.id
                     ORDER BY created_at DESC
                     LIMIT 1
                   ) s ON TRUE
             WHERE m.user_id = %s AND m.status = 'READY'
        """
        items_sql = """
            SELECT a.title, m.title
              FROM meeting_action_items a
              JOIN meetings m ON m.id = a.meeting_id
             WHERE m.user_id = %s AND a.status <> 'DONE'
        """
        # Narrowed to what the reader chose, when they chose. "Add context" is
        # a statement about what the next question is about, so the chips have
        # to move with it — offering workspace-level suggestions over three
        # meetings somebody just selected is the picker visibly not working.
        m_params: list = [user_id]
        i_params: list = [user_id]
        if meeting_ids:
            meetings_sql += " AND m.id = ANY(%s)"
            m_params.append(list(meeting_ids))
            items_sql += " AND a.meeting_id = ANY(%s)"
            i_params.append(list(meeting_ids))
        meetings_sql += " ORDER BY m.created_at DESC LIMIT %s"
        m_params.append(MAX_MEETINGS)
        items_sql += " ORDER BY a.due_date NULLS LAST, a.created_at LIMIT %s"
        i_params.append(MAX_OPEN_ITEMS)

        try:
            async with self.connection(user_id) as conn:
                async with conn.cursor() as cur:
                    await cur.execute(meetings_sql, tuple(m_params))
                    meetings = await cur.fetchall()
                    await cur.execute(items_sql, tuple(i_params))
                    items = await cur.fetchall()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not read workspace material for %s: %s", user_id, exc)
            return ""

        return workspace_material(
            [(m[0], m[1], m[2]) for m in meetings],
            [(i[0], i[1]) for i in items],
        )

    # --- workspace-wide retrieval ------------------------------------------- #
    async def _retrieve(
        self,
        user_id: str,
        q_emb: list[float],
        meeting_ids: list[str] | None,
        limit: int,
        since: datetime | None = None,
        until: datetime | None = None,
        not_before: datetime | None = None,
    ) -> list[tuple]:
        """Nearest chunks for one embedding, optionally inside a date range.

        The range is half-open — `since <= created_at < until` — so calling this
        twice with a shared boundary partitions the archive instead of returning
        the meeting on the boundary in both halves, which would make a
        comparison quote the same passage as both "recent" and "earlier".

        Filtering happens in SQL rather than after retrieval: post-filtering
        takes the top-k of everything and then throws most of it away, which on
        a workspace with a year of meetings leaves a "last week" question
        answering from two surviving chunks.
        """
        sql = """
            SELECT c.chunk_index, c.text, c.start_time, c.end_time,
                   c.meeting_id, m.title, m.created_at,
                   c.embedding <=> %s::vector AS distance
              FROM transcript_chunks c
              JOIN meetings m ON m.id = c.meeting_id
             WHERE c.user_id = %s
        """
        params: list = [_vec_literal(q_emb), user_id]
        if meeting_ids:
            sql += " AND c.meeting_id = ANY(%s)"
            params.append(list(meeting_ids))
        if since is not None:
            sql += " AND m.created_at >= %s"
            params.append(since)
        # The account's floor, applied on top of whatever the question asked
        # for. Separate from `since` rather than folded into it so a question
        # about last March still says "I found nothing from March" instead of
        # quietly answering from whatever the floor happened to leave visible.
        if not_before is not None:
            sql += " AND m.created_at >= %s"
            params.append(not_before)
        if until is not None:
            sql += " AND m.created_at < %s"
            params.append(until)
        sql += " ORDER BY distance LIMIT %s"
        params.append(limit)

        async with self.connection(user_id) as conn:
            async with conn.cursor() as cur:
                await cur.execute(sql, tuple(params))
                return await cur.fetchall()

    async def answer_workspace(
        self,
        user_id: str,
        question: str,
        meeting_ids: list[str] | None = None,
        mode: str = "express",
        history_days: int | None = None,
        history: list[str] | None = None,
    ) -> tuple[str, list[dict]]:
        """Answer a question grounded in EVERY meeting the user owns.

        Retrieval is filtered by `user_id`, so a user can never be grounded in
        another user's transcript. `meeting_ids`, when given, narrows the search
        to a subset (e.g. "only these three calls").

        `mode` decides how hard to look, and the two differ in three ways so
        that neither is a worse version of the other:

        * **express** — one pass at `rag_workspace_top_k` passages, from at most
          `rag_max_passages_per_meeting` of any one meeting, written short.
        * **advanced** — `rag_workspace_deep_top_k` passages over a wider
          candidate scan, more of each meeting allowed, and written to cover
          every theme the evidence supports. Costs proportionally more context
          and time, which is why it is a choice rather than the default.

        Advanced deliberately no longer forces enumeration. It used to, so
        "what does JWT mean here?" came back as a single bullet under the line
        "Total: 1." Depth is about evidence; whether the answer is a counted
        list is about what was asked.

        The commitment and decision ledgers are in both. They are the complete
        record rather than a retrieved sample, and withholding them from the
        cheaper mode would make it confidently wrong about what is outstanding
        rather than merely shallower.

        `history_days` is the account's own floor on how far back retrieval
        reaches. It bounds transcripts and deliberately not the ledgers, for the
        same reason: a task owed since March is still owed, and dropping it
        because its transcript is out of window would make the answer wrong
        rather than narrower.
        """
        if not self.enabled:
            return ("Workspace chat is not configured on this deployment.", [])

        deep = mode == "advanced"
        intent = classify(question)
        report = RetrievalReport(mode="advanced" if deep else "express", intent=intent)
        q_emb = (await self._embedder.embed([question]))[0]
        top_k = (
            self._settings.rag_workspace_deep_top_k
            if deep
            else self._settings.rag_workspace_top_k
        )
        candidates = top_k * self._settings.rag_candidate_multiplier

        # "What did we decide in the Product Marketing Weekly?" names a meeting.
        # Answering it from three other meetings whose text happens to sit
        # nearby in embedding space is not a partial answer, it is a different
        # question — so a named meeting narrows retrieval outright rather than
        # merely scoring higher.
        if not meeting_ids and could_name_a_meeting(question):
            named = await self._meetings_named_in(user_id, question)
            if named:
                meeting_ids = named
                report.notes.append("named-meeting")

        person = named_person(question)
        boost_terms = retrieval.tokens(person) if person else None
        if person:
            report.notes.append("named-person")

        # A claim about several meetings needs room for several meetings; a
        # lookup does not, and letting one meeting fill the context is how a
        # workspace answer quietly becomes a single-meeting answer.
        cap = (
            self._settings.rag_deep_max_passages_per_meeting
            if deep or spans_meetings(intent)
            else self._settings.rag_max_passages_per_meeting
        )

        # How many rows the scan produced at all, across both halves of a
        # comparison. Distinct from `report.considered`, which the second call
        # overwrites, and distinct from what survived: an archive with nothing
        # in it and an archive with nothing relevant are different answers.
        scanned = 0

        def keep(rows: list[tuple], limit: int) -> list[Candidate]:
            nonlocal scanned
            scanned += len(rows)
            return retrieval.select(
                rows,
                question,
                limit=limit,
                max_distance=self._settings.rag_max_distance,
                margin=self._settings.rag_relevance_margin,
                minimum=self._settings.rag_min_passages,
                lexical_weight=self._settings.rag_lexical_weight,
                duplicate_similarity=self._settings.rag_duplicate_similarity,
                per_meeting_cap=cap,
                workspace=True,
                boost_terms=boost_terms,
                boost=self._settings.rag_name_boost,
                report=report,
            )

        # "What changed since last week?" is a question about a period, and
        # nearest-neighbour search has no notion of one — it would answer from
        # whichever passages sit closest in embedding space, quite possibly from
        # March. When the question names a window, retrieval is run inside it.
        window = detect_window(question)
        floor = _history_floor(history_days)

        try:
            if window is None:
                rows = await self._retrieve(
                    user_id, q_emb, meeting_ids, candidates, not_before=floor
                )
                recent, earlier = keep(rows, top_k), []
            else:
                # A comparison needs both halves or there is nothing to have
                # changed from, and the two are retrieved separately so the
                # older half cannot crowd the recent half out of the top-k.
                # Split evenly rather than doubling the budget: the context
                # window is the same size either way.
                half = max(1, top_k // 2) if window.comparative else top_k
                recent = keep(
                    await self._retrieve(
                        user_id, q_emb, meeting_ids, half * self._settings.rag_candidate_multiplier,
                        since=window.start, until=window.end, not_before=floor,
                    ),
                    half,
                )
                earlier = (
                    keep(
                        await self._retrieve(
                            user_id, q_emb, meeting_ids,
                            (top_k - half) * self._settings.rag_candidate_multiplier,
                            until=window.start, not_before=floor,
                        ),
                        top_k - half,
                    )
                    if window.comparative
                    else []
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Workspace retrieval failed for user %s: %s", user_id, exc)
            return ("I couldn't search your meetings right now.", [])

        kept = recent + earlier
        ledger = await self._commitment_context(user_id, meeting_ids)
        decisions = await self._decision_context(user_id, meeting_ids)

        # No transcript survived the filter. Whether that ends the question
        # depends on what was asked: the ledgers are the complete record of what
        # is owed and what was decided, so "what is still outstanding?" is
        # answerable from them with no passage at all — and a lookup is not.
        # Without this split, a question about something nobody has ever
        # discussed is answered by a model handed only the action-item list,
        # which describes that list back rather than saying it found nothing.
        if not kept and not spans_meetings(intent):
            self._log_retrieval(report)
            if window is not None and scanned == 0:
                return (
                    f"I couldn't find any meetings from {window.label}. Try asking "
                    "without the time frame, or over a longer period.",
                    [],
                )
            if scanned == 0:
                return (
                    "I don't have any indexed meetings for you yet. Upload a meeting "
                    "and I'll be able to answer questions across all of them.",
                    [],
                )
            return ("I couldn't find this in the meetings currently in scope.", [])

        if not kept and not ledger and not decisions:
            self._log_retrieval(report)
            if window is not None and scanned == 0:
                return (
                    f"I couldn't find any meetings from {window.label}. Try asking "
                    "without the time frame, or over a longer period.",
                    [],
                )
            if scanned == 0:
                return (
                    "I don't have any indexed meetings for you yet. Upload a meeting "
                    "and I'll be able to answer questions across all of them.",
                    [],
                )
            # Something was there and none of it was about this. Said in one
            # sentence and left there: the old behaviour was to answer anyway
            # from the least-unrelated passages in the archive, which is where
            # "I found three potentially relevant recordings" came from.
            return ("I couldn't find this in the meetings currently in scope.", [])

        # `context` is what the model reads; `origins` is the same list with the
        # candidate each line came from, or None where the line is a ledger
        # entry or a separator. They are built together and must stay the same
        # length — see `_cited`.
        context: list[str] = []
        origins: list = []

        def add(line: str, origin=None) -> None:
            context.append(line)
            origins.append(origin)

        # Retrieval only ever sees transcript text, which records what people
        # *promised* and can never record what happened afterwards. Asked "what
        # hasn't been completed?", a purely retrieval-grounded answer therefore
        # lists everything anyone ever committed to — including the items the
        # user closed last week — and states it with total confidence. The
        # tracker holds the missing half, so it is put in front of the model.
        for line in decisions:
            add(line)
        for line in ledger:
            add(line)

        # Label each passage with its meeting and date so the model can attribute
        # answers across calls ("in the Acme kickoff you said...") and can tell
        # which of two conflicting statements came later.
        if window is None:
            for c in kept:
                add(_passage_of(c), c)
        else:
            add(
                "The passages below are grouped by when the meeting happened. "
                f"The question is about {window.label}."
            )
            add(f"--- From {window.label} ---")
            for c in recent:
                add(_passage_of(c), c)
            if earlier:
                add(f"--- From before {window.label}, for comparison only ---")
                for c in earlier:
                    add(_passage_of(c), c)
                add(
                    "Answer about what is in the first group. Use the second only "
                    "to say what is different, and never present it as recent."
                )

        report.context_chars = sum(len(c) for c in context)
        # The ledger is complete — every action item, not a retrieved sample —
        # so an inventory question fails on *writing*, not on evidence. Told to
        # be concise, the model merges near-identical items into one line:
        # fifteen tracked items come back as thirteen bullets, complete and
        # uncountable. This asks it to enumerate instead. Mode does not enter
        # into it; the question does.
        answer = _as_answer(
            await self._llm.answer(
                question,
                context,
                exhaustive=wants_enumeration(intent) or wants_full_list(question),
                intent=intent,
                depth="advanced" if deep else "express",
                history=history,
            )
        )
        cited = _cited(origins, answer.used)
        report.used = len(cited)
        self._log_retrieval(report)
        citations = [
            {
                "chunkIndex": c.chunk_index,
                "start": c.start,
                "end": c.end,
                "text": c.text,
                "meetingId": c.meeting_id,
                "meetingTitle": c.meeting_title,
            }
            for c in cited
        ]
        return (answer.text, citations)

    async def _meetings_named_in(self, user_id: str, question: str) -> list[str]:
        """Ids of meetings whose titles the question names, or an empty list.

        Titles are read rather than guessed at, and only recent ones: a question
        naming a meeting is naming one the person remembers, and scanning an
        archive of thousands to honour that would cost more than the narrowing
        saves. Never raises — failing to spot a named meeting costs a wider
        search, which is where this started.
        """
        try:
            async with self.connection(user_id) as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        """
                        SELECT id, title FROM meetings
                         WHERE user_id = %s AND title IS NOT NULL
                         ORDER BY created_at DESC LIMIT 200
                        """,
                        (user_id,),
                    )
                    rows = await cur.fetchall()
            # Inside the guard as well: a row that is not the shape this expects
            # is the same class of problem as a query that would not run, and
            # both cost a wider search rather than an error.
            by_title = {title: mid for mid, title in rows}
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not read meeting titles for %s: %s", user_id, exc)
            return []

        hits = names_meeting(question, list(by_title))
        return [by_title[t] for t in hits]

    async def search(self, user_id: str, query: str, limit: int | None = None) -> list[dict]:
        """Semantic search across the user's transcripts.

        Returns the best-matching passage per meeting so results read as a list
        of meetings, not a list of near-identical chunks from the same call.

        The query is deliberately staged. The inner CTE is a plain
        `ORDER BY embedding <=> const LIMIT n`, which is the only shape the
        ivfflat index can serve; deduplicating in that same query (an earlier
        `DISTINCT ON ... ORDER BY meeting_id, distance`) forced a sequential scan
        over every chunk the user owns. Dedup and the meetings join therefore
        happen afterwards, over a small candidate set.

        Because the owner filter is applied alongside the ANN scan, candidates
        are over-fetched: the index returns nearest rows globally and some are
        discarded, so a bare LIMIT would under-fill the result.
        """
        if not self.enabled:
            return []

        q_emb = (await self._embedder.embed([query]))[0]
        cap = limit or self._settings.rag_search_limit
        candidate_cap = cap * self._settings.rag_search_overfetch
        vec = _vec_literal(q_emb)
        try:
            async with self.connection(user_id) as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        """
                        WITH candidates AS (
                            SELECT c.meeting_id, c.chunk_index, c.text,
                                   c.start_time, c.end_time,
                                   c.embedding <=> %s::vector AS distance
                              FROM transcript_chunks c
                             WHERE c.user_id = %s
                             ORDER BY c.embedding <=> %s::vector
                             LIMIT %s
                        ),
                        best AS (
                            SELECT DISTINCT ON (meeting_id)
                                   meeting_id, chunk_index, text,
                                   start_time, end_time, distance
                              FROM candidates
                             ORDER BY meeting_id, distance
                        )
                        SELECT b.meeting_id, m.title, b.chunk_index, b.text,
                               b.start_time, b.end_time, m.created_at, b.distance
                          FROM best b
                          JOIN meetings m ON m.id = b.meeting_id
                         ORDER BY b.distance
                         LIMIT %s
                        """,
                        (vec, user_id, vec, candidate_cap, cap),
                    )
                    rows = await cur.fetchall()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Semantic search failed for user %s: %s", user_id, exc)
            return []

        return [
            {
                "meetingId": r[0],
                "meetingTitle": r[1],
                "chunkIndex": r[2],
                "snippet": r[3],
                "start": r[4],
                "end": r[5],
                "meetingCreatedAt": r[6].isoformat() if r[6] is not None else None,
                # `<=>` is cosine distance in [0,2]; present it as a similarity.
                "score": round(max(0.0, 1.0 - float(r[7])), 4),
            }
            for r in rows
        ]

    # --- helpers ------------------------------------------------------------ #
    def _chunk(self, transcript: str, segments: list[Segment]) -> list[dict]:
        """Group consecutive segments into overlapping, speaker-labelled passages.

        Two things here decide how good retrieval is.

        **The speaker prefix.** Each turn is rendered "Speaker 1: ..." exactly as
        the transcript itself is (see the adapter's `_join`). Without it the
        passage says only *what* was said, so "I'll have it by Friday" retrieves
        with no way to tell who promised it — and first-person commitments are
        most of what anyone asks a meeting about.

        **The overlap.** Passages are cut on a character budget, and an answer
        lying across a cut used to be split in half, leaving neither side able to
        support it. Consecutive passages now share a tail, so a boundary no
        longer falls in the middle of the only sentence that mattered.
        """
        budget = self._settings.rag_chunk_chars
        overlap = min(self._settings.rag_chunk_overlap_chars, max(budget - 1, 0))

        if not segments:
            text = (transcript or "").strip()
            step = max(budget - overlap, 1)
            return [
                {"text": text[i : i + budget], "start": None, "end": None}
                for i in range(0, len(text), step)
                if text[i : i + budget].strip()
            ]

        turns = []
        for seg in segments:
            body = (seg.text or "").strip()
            if not body:
                continue
            speaker = (seg.speaker or "").strip()
            line = f"{speaker}: {body}" if speaker else body
            turns.append({"line": line, "start": seg.start, "end": seg.end})

        chunks: list[dict] = []
        i = 0
        while i < len(turns):
            taken: list[dict] = []
            length = 0
            j = i
            # Always take one turn, so a single turn longer than the budget
            # still forms a chunk instead of stalling.
            while j < len(turns) and (not taken or length < budget):
                taken.append(turns[j])
                length += len(turns[j]["line"]) + 1
                j += 1

            chunks.append({
                "text": "\n".join(t["line"] for t in taken),
                "start": taken[0]["start"],
                "end": taken[-1]["end"],
            })

            if j >= len(turns):
                break

            # Rewind far enough to repeat ~`overlap` characters at the head of
            # the next chunk. Never past `i + 1`: the rewind must not cancel out
            # the advance, or the loop would emit the same chunk forever.
            back = 0
            k = j
            while k > i + 1 and back < overlap:
                k -= 1
                back += len(turns[k]["line"]) + 1
            i = k

        return [c for c in chunks if c["text"].strip()]
