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

from app.config import Settings
from app.providers.ports import EmbeddingPort, LlmPort
from app.schemas import Segment

logger = logging.getLogger("ai-service.rag")


def _vec_literal(embedding: list[float]) -> str:
    """Encode a vector as a pgvector text literal: '[0.1,0.2,...]'."""
    return "[" + ",".join(f"{x:.6f}" for x in embedding) + "]"


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
            f"password={self._settings.pg_password}"
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
    async def connection(self, user_id: str | None = None, *, system: bool = False):
        """A pooled connection with its tenant stamped on it.

        Every table this service touches is under row-level security (V9), so a
        connection without `app.user_id` set reads nothing at all. That is the
        intended failure: a query that forgets its tenant returns empty rather
        than returning somebody else's meeting.

        The settings are written on each checkout, never conditionally, because
        the pool hands the same connection to the next caller — anything left
        behind would be inherited. `system=True` is only for the indexing path,
        which has to resolve a meeting's owner before it knows who that is.
        """
        async with self._pool.connection() as conn:  # type: ignore[union-attr]
            await conn.execute(
                "SELECT set_config('app.user_id', %s, false), "
                "set_config('app.bypass', %s, false)",
                (user_id or "", "on" if system else "off"),
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
        filter by owner without joining `meetings`. When it is unknown (older
        events that predate the field) it is resolved from the meeting row.
        """
        if not self.enabled:
            return
        chunks = self._chunk(transcript, segments)
        if not chunks:
            return
        embeddings = await self._embedder.embed([c["text"] for c in chunks])
        try:
            # System context: when the owner is unknown this has to read the
            # meeting row to find out who it is, which no tenant setting could
            # yet permit. Indexing is worker-side infrastructure, never reached
            # from a user request.
            async with self.connection(user_id, system=True) as conn:
                async with conn.cursor() as cur:
                    if not user_id:
                        await cur.execute(
                            "SELECT user_id FROM meetings WHERE id = %s", (meeting_id,)
                        )
                        row = await cur.fetchone()
                        user_id = row[0] if row else None

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
        answer = await self._llm.answer(question, context)
        citations = [
            {"chunkIndex": r[0], "start": r[2], "end": r[3], "text": r[1]} for r in rows
        ]
        return (answer, citations)

    # --- workspace-wide retrieval ------------------------------------------- #
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
        sql += " ORDER BY distance LIMIT %s"
        params.append(top_k)

        try:
            async with self.connection(user_id) as conn:
                async with conn.cursor() as cur:
                    await cur.execute(sql, tuple(params))
                    rows = await cur.fetchall()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Workspace retrieval failed for user %s: %s", user_id, exc)
            return ("I couldn't search your meetings right now.", [])

        if not rows:
            return (
                "I don't have any indexed meetings for you yet. Upload a meeting "
                "and I'll be able to answer questions across all of them.",
                [],
            )

        # Label each passage with its meeting so the model can attribute answers
        # across calls ("in the Acme kickoff you said...").
        context = [f"[Meeting: {r[5]}] {r[1]}" for r in rows]
        answer = await self._llm.answer(question, context)
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
        """Group consecutive segments into ~chunk_chars passages with time spans."""
        budget = self._settings.rag_chunk_chars
        chunks: list[dict] = []

        if segments:
            buf: list[str] = []
            length = 0
            start: float | None = None
            end: float | None = None
            for seg in segments:
                text = (seg.text or "").strip()
                if not text:
                    continue
                if start is None:
                    start = seg.start
                buf.append(text)
                length += len(text) + 1
                end = seg.end
                if length >= budget:
                    chunks.append({"text": " ".join(buf), "start": start, "end": end})
                    buf, length, start, end = [], 0, None, None
            if buf:
                chunks.append({"text": " ".join(buf), "start": start, "end": end})
        else:
            text = (transcript or "").strip()
            for i in range(0, len(text), budget):
                chunks.append({"text": text[i : i + budget], "start": None, "end": None})

        return [c for c in chunks if c["text"].strip()]
