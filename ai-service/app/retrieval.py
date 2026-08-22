"""Turning nearest neighbours into evidence.

`ORDER BY embedding <=> query LIMIT k` always returns k rows. It has no opinion
about whether any of them are any good — asked about a topic nobody has ever
discussed, it returns the k least-unrelated passages in the archive with the
same confidence it returns an exact match. Everything downstream then treats
those as evidence: they go in the prompt, they come back as citations, and the
model, handed a question it cannot answer from material it was told to answer
from, does the only honest thing left and narrates the weakness of what it was
given.

That is the whole of the bug this module exists to fix. It sits between the ANN
scan and the prompt, and its job is to say *no*.

## The thresholds are measured, not chosen

Cosine distance from `text-embedding-3-small` does not have a universal cutoff,
and picking one by intuition is how a filter ends up either useless or
catastrophic. Measured against a real indexed workspace:

    question                                          best distance
    ------------------------------------------------  -------------
    "What were the key product features highlighted?"        0.613
    "What did the speaker say about the conference?"         0.587
    "What is the recipe for sourdough bread?"                0.869
    "How do I replace the brake pads on a Honda Civic?"      0.913
    "What were the casualty figures at Waterloo?"            0.924

Two things follow, and both are load-bearing.

**Nothing scores near zero.** The best match for a question the corpus answers
well is 0.59. A filter set anywhere below that — which is where anyone reaching
for "high similarity" would put it — returns nothing at all, for every question,
forever.

**The gap between answerable and unanswerable is wide and empty.** Real
questions bottom out around 0.6; questions about material that is simply absent
start at 0.87. `MAX_DISTANCE` sits at 0.80, in the middle of that empty band,
with room on both sides for a corpus that is not this one.

The relative margin does the other half of the work. Absolute distance says
whether anything is relevant at all; the margin says which of the survivors are
in the same league as the best one. On the first question above, the strongest
meeting's passages run 0.613–0.680 and a second meeting appears at 0.711 —
comfortably inside the archive, comfortably behind the leader. That shape is the
signal, and it is invisible to any fixed cutoff.

## What this module is not

It is not a reranking service and does not call one. The reranking here is
arithmetic over what the database already returned — a lexical overlap term
blended into the vector score — which costs nothing, adds no dependency, and
recovers the one thing embeddings are worst at: exact tokens. "Stripe", "Kafka",
"JWT" and somebody's surname are all words where being *near* the right meaning
is not the same as being the right word.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime

# Words that carry no retrieval signal. Short on purpose: a stop list long
# enough to be principled starts removing words that matter in a meeting
# ("open", "done", "next"), and the lexical term is a nudge rather than a
# ranking of its own.
_STOP = frozenset(
    """
    a an and are as at be been but by can could did do does for from had has have
    how i if in into is it its me my of on or our should so than that the their
    them then there these they this to was we were what when where which who why
    will with would you your about did what's whats
    """.split()
)

_WORD = re.compile(r"[a-z0-9][a-z0-9'\-]*")


def tokens(text: str) -> set[str]:
    """Content words, lowercased. The unit both the lexical score and the
    duplicate check work in."""
    return {w for w in _WORD.findall(text.lower()) if w not in _STOP and len(w) > 2}


@dataclass(frozen=True)
class Candidate:
    """One retrieved passage, and everything the filters need to judge it.

    A row from either query shaped into one type, so the pipeline below is
    written once. The single-meeting query has no meeting title to carry —
    the meeting is the question's subject — and leaves those fields unset.
    """

    chunk_index: int
    text: str
    start: float | None = None
    end: float | None = None
    meeting_id: str | None = None
    meeting_title: str | None = None
    created_at: datetime | None = None
    distance: float = 0.0
    # Filled by `rerank`. Kept on the candidate rather than returned alongside
    # so ordering, filtering and diagnostics all read the same number.
    score: float = 0.0

    @staticmethod
    def from_workspace_row(row: tuple) -> "Candidate":
        """`_retrieve`'s row: index, text, start, end, meeting_id, title, created, distance."""
        return Candidate(
            chunk_index=row[0],
            text=row[1] or "",
            start=row[2],
            end=row[3],
            meeting_id=row[4],
            meeting_title=row[5],
            created_at=row[6],
            distance=float(row[7]) if row[7] is not None else 0.0,
        )

    @staticmethod
    def from_meeting_row(row: tuple) -> "Candidate":
        """The single-meeting row: index, text, start, end, distance."""
        return Candidate(
            chunk_index=row[0],
            text=row[1] or "",
            start=row[2],
            end=row[3],
            distance=float(row[4]) if len(row) > 4 and row[4] is not None else 0.0,
        )


@dataclass
class RetrievalReport:
    """What the pipeline did, for the developer and for nobody else.

    Counts and durations only — never passage text, never a question, never a
    meeting title. This is written to the debug log and to the mode-comparison
    command, both of which run on machines where a transcript must not land in
    a log file.
    """

    mode: str = "express"
    intent: str = "fact"
    # The answer policy, which is the other half of what makes two answers to
    # the same question differ. `guidance` is what we permitted; `grounding` is
    # what the model says it did with the permission. Both are labels, not
    # content: knowing that a how_to question produced a mixed answer says
    # nothing about which meeting or whose.
    guidance: bool = False
    grounding: str = "meeting_only"
    considered: int = 0
    kept: int = 0
    meetings: int = 0
    used: int = 0
    dropped_unrelated: int = 0
    dropped_trailing: int = 0
    dropped_duplicate: int = 0
    dropped_crowding: int = 0
    best_distance: float | None = None
    worst_kept_distance: float | None = None
    context_chars: int = 0
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "mode": self.mode,
            "intent": self.intent,
            "guidanceAllowed": self.guidance,
            "grounding": self.grounding,
            "considered": self.considered,
            "kept": self.kept,
            "used": self.used,
            "meetings": self.meetings,
            "droppedUnrelated": self.dropped_unrelated,
            "droppedTrailing": self.dropped_trailing,
            "droppedDuplicate": self.dropped_duplicate,
            "droppedCrowding": self.dropped_crowding,
            "bestDistance": self.best_distance,
            "worstKeptDistance": self.worst_kept_distance,
            "contextChars": self.context_chars,
            "notes": list(self.notes),
        }


# --- the pieces -------------------------------------------------------------- #

def lexical_score(question_tokens: set[str], text: str) -> float:
    """How much of the question's vocabulary actually appears in the passage.

    Nought to one, over the question's content words. Deliberately not TF-IDF:
    the corpus is one user's meetings and the document frequencies that would
    make weighting meaningful are not available at query time without a second
    scan. What this catches is the case embeddings reliably miss — a rare exact
    token, which is to say a product name, an acronym or a person.
    """
    if not question_tokens:
        return 0.0
    found = question_tokens & tokens(text)
    return len(found) / len(question_tokens)


def rerank(
    candidates: list[Candidate],
    question: str,
    *,
    lexical_weight: float,
    boost_terms: set[str] | None = None,
    boost: float = 0.0,
) -> list[Candidate]:
    """Score every candidate and sort best-first.

    The blend is deliberately gentle. Vector similarity is the ranking; lexical
    overlap breaks its ties and rescues exact tokens. Given a large weight the
    lexical term starts promoting passages that merely repeat the question's
    words back — a passage saying "I don't know what the key product features
    are" scores full marks on every word in it.

    `boost_terms` is how a named person or a named meeting is honoured without a
    second retrieval system: the terms are already in the passage text, so a
    passage containing them is simply scored higher. It cannot manufacture
    evidence — a passage that survives on the boost still had to clear the
    relevance filter first.
    """
    q_tokens = tokens(question)
    ranked: list[Candidate] = []
    for c in candidates:
        # pgvector cosine distance is 1 - cosine similarity for unit vectors.
        similarity = 1.0 - c.distance
        lex = lexical_score(q_tokens, c.text)
        score = (1.0 - lexical_weight) * similarity + lexical_weight * lex
        if boost_terms and boost > 0 and boost_terms & tokens(c.text):
            score += boost
        ranked.append(
            Candidate(
                chunk_index=c.chunk_index,
                text=c.text,
                start=c.start,
                end=c.end,
                meeting_id=c.meeting_id,
                meeting_title=c.meeting_title,
                created_at=c.created_at,
                distance=c.distance,
                score=score,
            )
        )
    ranked.sort(key=lambda c: (-c.score, c.distance))
    return ranked


def drop_unrelated(candidates: list[Candidate], max_distance: float) -> list[Candidate]:
    """Everything past the measured edge of the archive.

    This is the filter that lets the chat say "I couldn't find this" instead of
    answering from the least-unrelated thing it owns. It runs on raw distance
    rather than on the blended score on purpose: a passage can pick up lexical
    points for repeating the question's words while being about nothing of the
    sort, and this is the one gate that must not be talked round.
    """
    return [c for c in candidates if c.distance <= max_distance]


def drop_trailing(
    candidates: list[Candidate], margin: float, minimum: int
) -> list[Candidate]:
    """The tail that is measurably worse than the best match.

    Relative, because absolute distance says whether anything is relevant and
    says nothing about which survivors are comparable. A question with one
    strong meeting and a scattering of weak echoes should be answered from the
    meeting.

    `minimum` is the guard against over-trimming: a diffuse but legitimate
    question ("what did we talk about?") can have a long shallow gradient with
    no clear leader, and cutting that to one passage answers a broad question
    from a sliver. Expects a best-first list.
    """
    if not candidates:
        return []
    best = candidates[0].distance
    kept = [c for c in candidates if c.distance <= best + margin]
    if len(kept) >= minimum:
        return kept
    return candidates[:minimum]


def dedupe(candidates: list[Candidate], similarity: float) -> list[Candidate]:
    """Near-identical passages, collapsed to the best of each.

    Chunks overlap by design — see `rag_chunk_overlap_chars`, which exists so a
    sentence cut by a boundary survives whole next door — so consecutive chunks
    genuinely share text. Two passages that are eighty per cent the same words
    spend two slots of the context window saying one thing, and cite the same
    moment twice.
    """
    kept: list[Candidate] = []
    seen: list[set[str]] = []
    for c in candidates:
        t = tokens(c.text)
        if not t:
            continue
        duplicate = False
        for other in seen:
            union = t | other
            if union and len(t & other) / len(union) >= similarity:
                duplicate = True
                break
        if not duplicate:
            kept.append(c)
            seen.append(t)
    return kept


def cap_per_meeting(candidates: list[Candidate], cap: int) -> list[Candidate]:
    """At most `cap` passages from any one meeting, best first.

    A workspace question wants the workspace's answer. Without this, one
    talkative meeting takes every slot — not because it is the best answer but
    because it has the most chunks — and the meetings that would have made the
    answer a synthesis never appear.

    Order is preserved, so the best passages survive and the crowding is trimmed
    from the bottom. Passages with no meeting id (single-meeting chat) are never
    capped: there is only one meeting and capping it would be capping the
    answer.
    """
    if cap <= 0:
        return candidates
    counts: dict[str, int] = {}
    kept: list[Candidate] = []
    for c in candidates:
        if c.meeting_id is None:
            kept.append(c)
            continue
        n = counts.get(c.meeting_id, 0)
        if n >= cap:
            continue
        counts[c.meeting_id] = n + 1
        kept.append(c)
    return kept


# --- the pipeline ------------------------------------------------------------ #

def select(
    rows: list[tuple],
    question: str,
    *,
    limit: int,
    max_distance: float,
    margin: float,
    minimum: int,
    lexical_weight: float,
    duplicate_similarity: float,
    per_meeting_cap: int,
    workspace: bool,
    boost_terms: set[str] | None = None,
    boost: float = 0.0,
    report: RetrievalReport | None = None,
) -> list[Candidate]:
    """Candidates in, evidence out.

    The order is not arbitrary. Unrelated passages go first, so nothing after
    this point is reasoning about noise. Reranking comes next, because every
    later decision — which tail to trim, which duplicate to keep, which meeting
    is crowding — is a decision about relative quality and needs the final
    ranking to make it. Diversity is applied before the limit rather than after,
    or the cap trims a list that has already been cut to one meeting.
    """
    rep = report or RetrievalReport()
    build = Candidate.from_workspace_row if workspace else Candidate.from_meeting_row
    candidates = [build(r) for r in rows]
    rep.considered = len(candidates)
    if candidates:
        rep.best_distance = round(min(c.distance for c in candidates), 4)

    related = drop_unrelated(candidates, max_distance)
    rep.dropped_unrelated = len(candidates) - len(related)
    if not related:
        rep.kept = 0
        rep.meetings = 0
        return []

    ranked = rerank(
        related, question, lexical_weight=lexical_weight,
        boost_terms=boost_terms, boost=boost,
    )

    trimmed = drop_trailing(ranked, margin, minimum)
    rep.dropped_trailing = len(ranked) - len(trimmed)

    unique = dedupe(trimmed, duplicate_similarity)
    rep.dropped_duplicate = len(trimmed) - len(unique)

    diverse = cap_per_meeting(unique, per_meeting_cap) if workspace else unique
    rep.dropped_crowding = len(unique) - len(diverse)

    kept = diverse[:limit]
    rep.kept = len(kept)
    rep.meetings = len({c.meeting_id for c in kept if c.meeting_id}) or (1 if kept else 0)
    if kept:
        rep.worst_kept_distance = round(max(c.distance for c in kept), 4)
    return kept
