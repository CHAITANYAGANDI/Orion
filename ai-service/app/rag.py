"""RAG service: chunk + embed transcripts into pgvector, retrieve, and answer.

Owns the transcript_chunks table directly (async psycopg). Vectors are passed
as `::vector` string casts, so no pgvector Python adapter is required. When
PG_HOST is unset the service disables itself gracefully (chat returns a friendly
message) so the app still boots.
"""

from __future__ import annotations

import logging
import uuid

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
            async with self._pool.connection() as conn:  # type: ignore[union-attr]
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
    async def answer(self, meeting_id: str, question: str) -> tuple[str, list[dict]]:
        if not self.enabled:
            return ("RAG chat is not configured on this deployment.", [])
        q_emb = (await self._embedder.embed([question]))[0]
        try:
            async with self._pool.connection() as conn:  # type: ignore[union-attr]
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
            async with self._pool.connection() as conn:  # type: ignore[union-attr]
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

        Returns the best-matching passage per meeting (deduplicated via
        DISTINCT ON) so results read as a list of meetings, not a list of
        near-identical chunks from the same call.
        """
        if not self.enabled:
            return []

        q_emb = (await self._embedder.embed([query]))[0]
        cap = limit or self._settings.rag_search_limit
        try:
            async with self._pool.connection() as conn:  # type: ignore[union-attr]
                async with conn.cursor() as cur:
                    await cur.execute(
                        """
                        SELECT meeting_id, title, chunk_index, text,
                               start_time, end_time, created_at, distance
                          FROM (
                            SELECT DISTINCT ON (c.meeting_id)
                                   c.meeting_id, m.title, c.chunk_index, c.text,
                                   c.start_time, c.end_time, m.created_at,
                                   c.embedding <=> %s::vector AS distance
                              FROM transcript_chunks c
                              JOIN meetings m ON m.id = c.meeting_id
                             WHERE c.user_id = %s
                             ORDER BY c.meeting_id, distance
                          ) best
                         ORDER BY distance
                         LIMIT %s
                        """,
                        (_vec_literal(q_emb), user_id, cap),
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
