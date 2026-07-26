"""Meeting Memory: commitment verdicts and decision drift.

These cover the judgement logic the mock provider stands in for, plus the
retrieval threshold that gates it. The point is that the *interesting* verdicts
— FULFILLED, SLIPPED, CANCELLED, CONTRADICTS — actually fire, and equally that
silence is never mistaken for progress.
"""

from __future__ import annotations

import pytest

from app.providers.mock_adapter import (
    SCRIPTS,
    MockEmbeddingAdapter,
    MockLlmAdapter,
    script_for_transcript,
    select_script,
)

WEEK_1, WEEK_2, WEEK_3 = SCRIPTS


@pytest.fixture
def llm() -> MockLlmAdapter:
    return MockLlmAdapter()


def _cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


# --------------------------------------------------------------------------- #
# Script selection
# --------------------------------------------------------------------------- #
def test_filename_digit_selects_the_week():
    assert select_script("week1.wav") is WEEK_1
    assert select_script("standup2.wav") is WEEK_2
    assert select_script("sprint-3.m4a") is WEEK_3


def test_selection_is_deterministic_without_a_digit():
    # Same bytes must always map to the same script, so reprocessing a meeting
    # does not silently change its transcript.
    first = select_script("audio.wav", b"some-audio-bytes")
    second = select_script("audio.wav", b"some-audio-bytes")
    assert first is second


def test_selection_falls_back_to_week_one():
    assert select_script(None, None) is WEEK_1
    assert select_script("", b"") is WEEK_1


def test_scripts_have_distinct_transcripts():
    transcripts = {s.transcript for s in SCRIPTS}
    assert len(transcripts) == len(SCRIPTS), "a repeated transcript cannot demo memory"


def test_extractions_follow_the_transcript():
    assert script_for_transcript(WEEK_2.transcript) is WEEK_2
    # Unknown text degrades to week 1 rather than returning nothing.
    assert script_for_transcript("something entirely unrelated") is WEEK_1


# --------------------------------------------------------------------------- #
# Commitment verdicts
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_week_two_fulfils_the_jwt_commitment(llm):
    commitment = WEEK_1.action_items[0].task_title  # JWT validation
    verdict = await llm.judge_commitment(commitment, "Chaitanya", [WEEK_2.transcript])
    assert verdict.outcome == "FULFILLED"
    assert "done" in verdict.quote.lower()


@pytest.mark.asyncio
async def test_week_two_slips_the_kafka_commitment(llm):
    commitment = WEEK_1.action_items[1].task_title  # Kafka consumer
    verdict = await llm.judge_commitment(commitment, "Priya", [WEEK_2.transcript])
    assert verdict.outcome == "SLIPPED"


@pytest.mark.asyncio
async def test_week_three_cancels_the_mock_provider_commitment(llm):
    commitment = WEEK_1.action_items[2].task_title  # mock provider
    verdict = await llm.judge_commitment(commitment, "Marco", [WEEK_3.transcript])
    assert verdict.outcome == "CANCELLED"


@pytest.mark.asyncio
async def test_week_three_fulfils_the_benchmark_commitment(llm):
    commitment = WEEK_2.action_items[0].task_title  # Benchmark Deepgram latency
    verdict = await llm.judge_commitment(commitment, "Ana", [WEEK_3.transcript])
    assert verdict.outcome == "FULFILLED"


@pytest.mark.asyncio
async def test_unmentioned_commitment_yields_no_evidence(llm):
    """The commitment is absent from week 3 — silence must not resolve it."""
    commitment = WEEK_1.action_items[0].task_title  # JWT, not discussed in week 3
    verdict = await llm.judge_commitment(commitment, "Chaitanya", [WEEK_3.transcript])
    assert verdict.outcome == "NO_EVIDENCE"


@pytest.mark.asyncio
async def test_no_evidence_carries_no_quote(llm):
    verdict = await llm.judge_commitment("Something never discussed at all", None, [WEEK_2.transcript])
    assert verdict.outcome == "NO_EVIDENCE"
    assert not verdict.quote


@pytest.mark.asyncio
async def test_empty_passages_yield_no_evidence(llm):
    verdict = await llm.judge_commitment("Finish JWT validation", "Chaitanya", [])
    assert verdict.outcome == "NO_EVIDENCE"


@pytest.mark.asyncio
async def test_verdict_is_scoped_to_the_matching_sentence(llm):
    """A "done" elsewhere in the meeting must not resolve an unrelated promise.

    Week 2 says JWT is *done* and the Kafka consumer *slipped* in the same
    transcript. Judging at passage level would return FULFILLED for both.
    """
    kafka = WEEK_1.action_items[1].task_title
    verdict = await llm.judge_commitment(kafka, "Priya", [WEEK_2.transcript])
    assert verdict.outcome == "SLIPPED"
    assert "kafka" in verdict.quote.lower()


# --------------------------------------------------------------------------- #
# Decision drift
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_week_two_contradicts_the_transcription_decision(llm):
    earlier = WEEK_1.decisions[1].decision  # Whisper
    later = WEEK_2.decisions[0].decision  # Deepgram instead
    relation = await llm.compare_decisions(earlier, later)
    assert relation.relation == "CONTRADICTS"
    assert relation.rationale


@pytest.mark.asyncio
async def test_week_three_reaffirms_the_storage_decision(llm):
    earlier = WEEK_1.decisions[0].decision
    later = WEEK_3.decisions[0].decision
    assert earlier == later
    relation = await llm.compare_decisions(earlier, later)
    assert relation.relation == "REAFFIRMS"


@pytest.mark.asyncio
async def test_unrelated_decisions_are_not_linked(llm):
    relation = await llm.compare_decisions(
        "Store the meeting audio in S3 using presigned URLs.",
        "Hire a second backend engineer in Q3.",
    )
    assert relation.relation == "UNRELATED"


@pytest.mark.asyncio
async def test_contradicting_decisions_clear_the_similarity_threshold():
    """Retrieval must surface the pair before the LLM can ever judge it.

    The drift pass discards candidates below `memory_drift_min_similarity`, so a
    contradiction that scores too low is invisible regardless of the prompt.
    """
    from app.config import get_settings

    embedder = MockEmbeddingAdapter()
    earlier = WEEK_1.decisions[1].decision
    later = WEEK_2.decisions[0].decision
    vectors = await embedder.embed([earlier, later])
    similarity = _cosine(vectors[0], vectors[1])
    assert similarity >= get_settings().memory_drift_min_similarity


@pytest.mark.asyncio
async def test_reaffirmed_decisions_are_maximally_similar():
    embedder = MockEmbeddingAdapter()
    vectors = await embedder.embed([WEEK_1.decisions[0].decision, WEEK_3.decisions[0].decision])
    assert _cosine(vectors[0], vectors[1]) == pytest.approx(1.0, abs=1e-6)


# --------------------------------------------------------------------------- #
# Degradation
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_reconcile_is_a_no_op_without_a_database():
    """Memory is advisory: with no pgvector pool it returns nothing, not an error."""
    from app.config import get_settings
    from app.memory import MemoryService
    from app.rag import RagService

    settings = get_settings()
    embedder = MockEmbeddingAdapter()
    llm = MockLlmAdapter()
    rag = RagService(settings, embedder, llm)  # never started -> no pool
    memory = MemoryService(settings, rag, embedder, llm)

    assert memory.enabled is False
    verdicts, links = await memory.reconcile("usr_1", "mtg_1", [], [])
    assert verdicts == []
    assert links == []
