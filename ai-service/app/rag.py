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

    # --- indexing ----------------------------------------------------------- #
    async def index(self, meeting_id: str, transcript: str, segments: list[Segment]) -> None:
        if not self.enabled:
            return
        chunks = self._chunk(transcript, segments)
        if not chunks:
            return
        embeddings = await self._embedder.embed([c["text"] for c in chunks])
        try:
            async with self._pool.connection() as conn:  # type: ignore[union-attr]
                async with conn.cursor() as cur:
                    await cur.execute(
                        "DELETE FROM transcript_chunks WHERE meeting_id = %s", (meeting_id,)
                    )
                    for i, (chunk, emb) in enumerate(zip(chunks, embeddings)):
                        await cur.execute(
                            """
                            INSERT INTO transcript_chunks
                                (id, meeting_id, chunk_index, text, start_time, end_time, embedding)
                            VALUES (%s, %s, %s, %s, %s, %s, %s::vector)
                            """,
                            (
                                "chk_" + uuid.uuid4().hex,
                                meeting_id,
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
