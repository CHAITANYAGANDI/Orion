"""Transcript chunking for retrieval.

Chunk shape is what decides whether "ask the meeting" can answer. Two failures
these cover are silent — retrieval simply returns less useful passages and the
answer looks merely mediocre rather than broken:

* dropping the speaker, which makes every first-person commitment unattributable
* cutting on a hard boundary, which halves any answer that spans the cut

The third, a rewind that cancels its own advance, is not silent at all: it hangs
the indexing task forever.
"""

from __future__ import annotations

from app.config import Settings
from app.rag import RagService
from app.schemas import Segment


def _svc(**overrides) -> RagService:
    # Chunking touches neither collaborator; both stay None so the test says so.
    return RagService(Settings(**overrides), embedder=None, llm=None)


def _segments(*pairs) -> list[Segment]:
    out, t = [], 0.0
    for speaker, text in pairs:
        out.append(Segment(start=t, end=t + 5, speaker=speaker, text=text))
        t += 5
    return out


def test_speaker_is_carried_into_the_passage():
    chunks = _svc()._chunk("", _segments(("Marcus", "I'll benchmark the consumer by Friday.")))
    assert chunks[0]["text"] == "Marcus: I'll benchmark the consumer by Friday."


def test_every_turn_keeps_its_own_attribution():
    chunks = _svc()._chunk("", _segments(("Ana", "Are we storing audio in S3?"),
                                         ("Marcus", "Yes, decided last week.")))
    text = chunks[0]["text"]
    assert "Ana: Are we storing audio in S3?" in text
    assert "Marcus: Yes, decided last week." in text


def test_missing_speaker_falls_back_to_bare_text():
    chunks = _svc()._chunk("", _segments(("", "No speaker on this turn.")))
    assert chunks[0]["text"] == "No speaker on this turn."


def test_consecutive_chunks_share_a_tail():
    segs = _segments(*[("S1", f"sentence number {i} " + "x" * 60) for i in range(12)])
    chunks = _svc(rag_chunk_chars=200, rag_chunk_overlap_chars=90)._chunk("", segs)

    assert len(chunks) > 1
    # The tail of one chunk must reappear at the head of the next, or a sentence
    # split across the boundary is lost to both.
    for earlier, later in zip(chunks, chunks[1:]):
        assert set(earlier["text"].splitlines()) & set(later["text"].splitlines())


def test_time_span_tracks_the_turns_taken():
    chunks = _svc(rag_chunk_chars=10_000)._chunk("", _segments(("S1", "a"), ("S2", "b")))
    assert chunks[0]["start"] == 0.0
    assert chunks[0]["end"] == 10.0


def test_a_turn_longer_than_the_budget_still_terminates():
    """The rewind must never undo the advance, or indexing hangs forever."""
    segs = _segments(*[("S1", "y" * 900) for _ in range(4)])
    chunks = _svc(rag_chunk_chars=100, rag_chunk_overlap_chars=90)._chunk("", segs)
    assert len(chunks) == 4


def test_overlap_wider_than_the_budget_is_clamped():
    segs = _segments(*[("S1", f"turn {i}") for i in range(8)])
    chunks = _svc(rag_chunk_chars=50, rag_chunk_overlap_chars=5000)._chunk("", segs)
    assert chunks  # terminated at all
    assert len(chunks) < 100


def test_plain_transcript_without_segments_also_overlaps():
    text = "".join(f"{i:03d}" for i in range(100))  # 300 chars
    chunks = _svc(rag_chunk_chars=100, rag_chunk_overlap_chars=20)._chunk(text, [])
    assert len(chunks) > 1
    assert chunks[0]["text"][-20:] in chunks[1]["text"]


def test_empty_input_yields_nothing():
    assert _svc()._chunk("", []) == []
    assert _svc()._chunk("   ", []) == []


def test_blank_turns_are_skipped():
    chunks = _svc()._chunk("", _segments(("S1", "  "), ("S2", "real content")))
    assert len(chunks) == 1
    assert chunks[0]["text"] == "S2: real content"
