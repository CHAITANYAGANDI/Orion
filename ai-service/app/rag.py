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
from datetime import datetime

from app.config import Settings
from app.providers.ports import EmbeddingPort, LlmPort
from app.questions import wants_full_list
from app.schemas import Segment
from app.timeframe import detect_window

logger = logging.getLogger("ai-service.rag")


def _vec_literal(embedding: list[float]) -> str:
    """Encode a vector as a pgvector text literal: '[0.1,0.2,...]'."""
    return "[" + ",".join(f"{x:.6f}" for x in embedding) + "]"


def _passage(row: tuple) -> str:
    """One retrieved chunk, labelled with its meeting and date.

    The date is what lets the model say which of two contradictory statements
    came later. Without it, "we decided X" and "we decided not-X" are two
    equally-present facts and the answer picks one arbitrarily.
    """
    created = row[6]
    when = created.date().isoformat() if isinstance(created, datetime) else ""
    stamp = f" · {when}" if when else ""
    return f"[Meeting: {row[5]}{stamp}] {row[1]}"


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
        self, meeting_id: str, question: str, user_id: str | None = None
    ) -> tuple[str, list[dict]]:
        """Answer a question about one meeting.

        `user_id` is what row-level security checks. Spring has already verified
        ownership before calling, but passing the owner means a bug there cannot
        turn into a cross-tenant read: the database independently refuses.
        """
        if not self.enabled:
            return ("RAG chat is not configured on this deployment.", [])
        q_emb = (await self._embedder.embed([question]))[0]
        try:
            async with self.connection(user_id) as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        """
                        SELECT chunk_index, text, start_time, end_time
                        FROM transcript_chunks
                        WHERE meeting_id = %s
                        ORDER BY embedding <=> %s::vector
                        LIMIT %s
                        """,
                        (meeting_id, _vec_literal(q_emb), self._settings.rag_top_k),
                    )
                    rows = await cur.fetchall()
        except Exception as exc:  # noqa: BLE001
            logger.warning("RAG retrieval failed for %s: %s", meeting_id, exc)
            return ("I couldn't search this meeting's transcript right now.", [])

        if not rows:
            return ("I don't have an indexed transcript for this meeting yet.", [])

        context = [r[1] for r in rows]
        # "List every question that went unanswered" is an inventory here too,
        # even though this chat sees one meeting rather than the workspace.
        answer = await self._llm.answer(
            question, context, exhaustive=wants_full_list(question)
        )
        citations = [
            {"chunkIndex": r[0], "start": r[2], "end": r[3], "text": r[1]} for r in rows
        ]
        return (answer, citations)

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

    # --- workspace-wide retrieval ------------------------------------------- #
    async def _retrieve(
        self,
        user_id: str,
        q_emb: list[float],
        meeting_ids: list[str] | None,
        limit: int,
        since: datetime | None = None,
        until: datetime | None = None,
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
    ) -> tuple[str, list[dict]]:
        """Answer a question grounded in EVERY meeting the user owns.

        Retrieval is filtered by `user_id`, so a user can never be grounded in
        another user's transcript. `meeting_ids`, when given, narrows the search
        to a subset (e.g. "only these three calls").
        """
        if not self.enabled:
            return ("Workspace chat is not configured on this deployment.", [])

        q_emb = (await self._embedder.embed([question]))[0]
        top_k = self._settings.rag_workspace_top_k

        # "What changed since last week?" is a question about a period, and
        # nearest-neighbour search has no notion of one — it would answer from
        # whichever passages sit closest in embedding space, quite possibly from
        # March. When the question names a window, retrieval is run inside it.
        window = detect_window(question)

        try:
            if window is None:
                rows = await self._retrieve(user_id, q_emb, meeting_ids, top_k)
                recent, earlier = rows, []
            else:
                # A comparison needs both halves or there is nothing to have
                # changed from, and the two are retrieved separately so the
                # older half cannot crowd the recent half out of the top-k.
                # Split evenly rather than doubling the budget: the context
                # window is the same size either way.
                half = max(1, top_k // 2) if window.comparative else top_k
                recent = await self._retrieve(
                    user_id, q_emb, meeting_ids, half, since=window.start, until=window.end
                )
                earlier = (
                    await self._retrieve(
                        user_id, q_emb, meeting_ids, top_k - half, until=window.start
                    )
                    if window.comparative
                    else []
                )
                rows = recent + earlier
        except Exception as exc:  # noqa: BLE001
            logger.warning("Workspace retrieval failed for user %s: %s", user_id, exc)
            return ("I couldn't search your meetings right now.", [])

        if not rows:
            if window is not None:
                return (
                    f"I couldn't find any meetings from {window.label}. Try asking "
                    "without the time frame, or over a longer period.",
                    [],
                )
            return (
                "I don't have any indexed meetings for you yet. Upload a meeting "
                "and I'll be able to answer questions across all of them.",
                [],
            )

        # Label each passage with its meeting and date so the model can attribute
        # answers across calls ("in the Acme kickoff you said...") and can tell
        # which of two conflicting statements came later.
        if window is None:
            context = [_passage(r) for r in rows]
        else:
            context = [
                f"The passages below are grouped by when the meeting happened. "
                f"The question is about {window.label}.",
                f"--- From {window.label} ---",
                *(_passage(r) for r in recent),
            ]
            if earlier:
                context += [
                    f"--- From before {window.label}, for comparison only ---",
                    *(_passage(r) for r in earlier),
                    "Answer about what is in the first group. Use the second only "
                    "to say what is different, and never present it as recent.",
                ]

        # Retrieval only ever sees transcript text, which records what people
        # *promised* and can never record what happened afterwards. Asked "what
        # hasn't been completed?", a purely retrieval-grounded answer therefore
        # lists everything anyone ever committed to — including the items the
        # user closed last week — and states it with total confidence. The
        # tracker holds the missing half, so it is put in front of the model.
        context = await self._commitment_context(user_id, meeting_ids) + context
        # And "do any decisions conflict?" cannot be answered from passages at
        # all: two contradictory decisions made six weeks apart are unlikely to
        # both land in one top-k, and even together they arrive undated. The
        # store holds every decision with the date it was made.
        context = await self._decision_context(user_id, meeting_ids) + context

        # The ledger above is complete — every action item, not a retrieved
        # sample — so an inventory question fails on *writing*, not on evidence.
        # Told to be concise, the model merges near-identical items into one
        # line: fifteen tracked items come back as thirteen bullets, complete
        # and uncountable. This asks it to enumerate instead.
        answer = await self._llm.answer(
            question, context, exhaustive=wants_full_list(question)
        )
        citations = [
            {
                "chunkIndex": r[0],
                "start": r[2],
                "end": r[3],
                "text": r[1],
                "meetingId": r[4],
                "meetingTitle": r[5],
            }
            for r in rows
        ]
        return (answer, citations)

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
