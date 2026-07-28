"""Meeting Memory: reconcile promises and decisions across meetings.

Two passes run whenever a meeting finishes processing:

  * **Commitment reconciliation** — for each promise still open from an earlier
    meeting, retrieve the passages of *this* meeting that are closest to it and
    ask the LLM what, if anything, this meeting says about it. Most pairs return
    NO_EVIDENCE; that is the expected outcome and is discarded.

  * **Decision drift** — embed this meeting's decisions, find the user's
    semantically-closest decisions from *other* meetings, and ask the LLM whether
    the pair actually conflicts. Retrieval proposes; the LLM disposes.

Both passes are advisory: any failure degrades to "found nothing" rather than
propagating, because a meeting must still complete if memory analysis fails.
The Postgres pool is borrowed from :class:`~app.rag.RagService` so there is a
single connection pool for the service.
"""

from __future__ import annotations

import asyncio
import logging

from app.config import Settings
from app.providers.ports import EmbeddingPort, LlmPort
from app.rag import RagService, _vec_literal
from app.schemas import (
    CommitmentInput,
    CommitmentVerdictResult,
    DecisionInput,
    DecisionLinkResult,
)

logger = logging.getLogger("ai-service.memory")


class MemoryService:
    """Cross-meeting reconciliation of commitments and decisions."""

    def __init__(
        self,
        settings: Settings,
        rag: RagService,
        embedder: EmbeddingPort,
        llm: LlmPort,
    ) -> None:
        self._settings = settings
        self._rag = rag
        self._embedder = embedder
        self._llm = llm

    @property
    def enabled(self) -> bool:
        # Memory is entirely pgvector-backed; without a pool there is nothing to do.
        return self._rag.enabled

    # --- entry point -------------------------------------------------------- #
    async def reconcile(
        self,
        user_id: str,
        meeting_id: str,
        open_commitments: list[CommitmentInput],
        decisions: list[DecisionInput],
    ) -> tuple[list[CommitmentVerdictResult], list[DecisionLinkResult]]:
        """Run both passes concurrently; either may return an empty list."""
        if not self.enabled:
            return ([], [])

        verdicts, links = await asyncio.gather(
            self._reconcile_commitments(user_id, meeting_id, open_commitments),
            self._detect_drift(user_id, meeting_id, decisions),
            return_exceptions=True,
        )
        if isinstance(verdicts, BaseException):
            logger.warning("Commitment reconciliation failed for %s: %s", meeting_id, verdicts)
            verdicts = []
        if isinstance(links, BaseException):
            logger.warning("Decision drift failed for %s: %s", meeting_id, links)
            links = []
        return (verdicts, links)

    # --- commitments -------------------------------------------------------- #
    async def _reconcile_commitments(
        self, user_id: str, meeting_id: str, commitments: list[CommitmentInput]
    ) -> list[CommitmentVerdictResult]:
        if not commitments:
            return []

        # One embedding call for every commitment, then one retrieval each.
        embeddings = await self._embedder.embed([c.text for c in commitments])

        async def judge(commitment: CommitmentInput, emb: list[float]) -> CommitmentVerdictResult | None:
            rows = await self._nearest_chunks(user_id, meeting_id, emb)
            if not rows:
                return None
            verdict = await self._llm.judge_commitment(
                commitment.text, commitment.owner_name, [r[0] for r in rows]
            )
            if verdict.outcome == "NO_EVIDENCE":
                return None
            return CommitmentVerdictResult(
                commitment_id=commitment.id,
                outcome=verdict.outcome,
                rationale=verdict.rationale,
                quote=verdict.quote,
                # Attribute the verdict to the closest passage's timestamp.
                start=rows[0][1],
                confidence=verdict.confidence,
            )

        results = await asyncio.gather(
            *(judge(c, e) for c, e in zip(commitments, embeddings)),
            return_exceptions=True,
        )
        verdicts: list[CommitmentVerdictResult] = []
        for r in results:
            if isinstance(r, BaseException):
                logger.warning("Commitment judgement failed: %s", r)
            elif r is not None:
                verdicts.append(r)
        return verdicts

    async def _nearest_chunks(
        self, user_id: str, meeting_id: str, embedding: list[float]
    ) -> list[tuple[str, float | None]]:
        """The passages of one meeting closest to a commitment."""
        try:
            async with self._rag.connection(user_id) as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        """
                        SELECT text, start_time
                          FROM transcript_chunks
                         WHERE meeting_id = %s
                         ORDER BY embedding <=> %s::vector
                         LIMIT %s
                        """,
                        (meeting_id, _vec_literal(embedding), self._settings.memory_evidence_k),
                    )
                    return list(await cur.fetchall())
        except Exception as exc:  # noqa: BLE001
            logger.warning("Evidence retrieval failed for %s: %s", meeting_id, exc)
            return []

    # --- decision drift ----------------------------------------------------- #
    async def _detect_drift(
        self, user_id: str, meeting_id: str, decisions: list[DecisionInput]
    ) -> list[DecisionLinkResult]:
        if not decisions:
            return []

        embeddings = await self._embedder.embed([d.text for d in decisions])
        await self._store_decision_vectors(user_id, meeting_id, decisions, embeddings)

        async def candidates_for(
            decision: DecisionInput, emb: list[float]
        ) -> list[DecisionLinkResult]:
            rows = await self._nearest_prior_decisions(user_id, meeting_id, emb)
            out: list[DecisionLinkResult] = []
            for prior_id, prior_text, distance in rows:
                similarity = max(0.0, 1.0 - float(distance))
                if similarity < self._settings.memory_drift_min_similarity:
                    continue
                relation = await self._llm.compare_decisions(prior_text, decision.text)
                if relation.relation == "UNRELATED":
                    continue
                out.append(
                    DecisionLinkResult(
                        earlier_decision_id=prior_id,
                        later_decision_id=decision.id,
                        relation=relation.relation,
                        rationale=relation.rationale,
                        similarity=round(similarity, 4),
                    )
                )
            return out

        results = await asyncio.gather(
            *(candidates_for(d, e) for d, e in zip(decisions, embeddings)),
            return_exceptions=True,
        )
        links: list[DecisionLinkResult] = []
        for r in results:
            if isinstance(r, BaseException):
                logger.warning("Drift comparison failed: %s", r)
            else:
                links.extend(r)
        return links

    async def _store_decision_vectors(
        self,
        user_id: str,
        meeting_id: str,
        decisions: list[DecisionInput],
        embeddings: list[list[float]],
    ) -> None:
        """Upsert this meeting's decision embeddings so future meetings can find them."""
        try:
            async with self._rag.connection(user_id) as conn:
                async with conn.cursor() as cur:
                    for decision, emb in zip(decisions, embeddings):
                        await cur.execute(
                            """
                            INSERT INTO decision_vectors
                                (decision_id, user_id, meeting_id, text, embedding)
                            VALUES (%s, %s, %s, %s, %s::vector)
                            ON CONFLICT (decision_id) DO UPDATE
                                SET text = EXCLUDED.text,
                                    embedding = EXCLUDED.embedding
                            """,
                            (decision.id, user_id, meeting_id, decision.text, _vec_literal(emb)),
                        )
                await conn.commit()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Storing decision vectors failed for %s: %s", meeting_id, exc)

    async def _nearest_prior_decisions(
        self, user_id: str, meeting_id: str, embedding: list[float]
    ) -> list[tuple[str, str, float]]:
        """The user's closest decisions from meetings OTHER than this one."""
        try:
            async with self._rag.connection(user_id) as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        """
                        SELECT decision_id, text, embedding <=> %s::vector AS distance
                          FROM decision_vectors
                         WHERE user_id = %s
                           AND meeting_id <> %s
                         ORDER BY distance
                         LIMIT %s
                        """,
                        (
                            _vec_literal(embedding),
                            user_id,
                            meeting_id,
                            self._settings.memory_drift_candidates,
                        ),
                    )
                    return list(await cur.fetchall())
        except Exception as exc:  # noqa: BLE001
            logger.warning("Prior-decision lookup failed for %s: %s", meeting_id, exc)
            return []
