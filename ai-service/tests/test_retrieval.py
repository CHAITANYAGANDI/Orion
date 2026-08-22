"""Turning nearest neighbours into evidence, and refusing to when there is none.

`ORDER BY embedding <=> query LIMIT k` returns k rows whatever is in the
archive. Asked about something nobody has ever discussed it returns the k
least-unrelated passages with exactly the same confidence as an exact match, and
everything downstream then treats them as evidence — they go in the prompt, they
come back as citations, and the model, handed a question it cannot answer from
material it was told to answer from, narrates the weakness of what it was given.

That is where "I found three potentially relevant recordings mentioning
'product' and 'features,' but the matches are fuzzy" came from. Not from the
prompt: from retrieval having no opinion.

The distances used below are the ones measured against a real indexed workspace
on text-embedding-3-small, not invented ones. Questions the archive answers
bottom out at 0.59-0.61; questions about absent material start at 0.87. Every
threshold here lives in that gap, and the fixtures are built from the real
numbers so that a change to the config has to face the same evidence the config
was chosen from.
"""

from __future__ import annotations

from app import retrieval
from app.retrieval import Candidate, RetrievalReport

MAX_DISTANCE = 0.80
MARGIN = 0.12
MINIMUM = 3


def row(meeting, index, text, distance):
    """A workspace row: index, text, start, end, meeting_id, title, created, distance."""
    return (index, text, 0.0, 1.0, meeting, meeting.upper(), None, distance)


# The scenario from the bug report, with real distances.
#
# A: a product-marketing discussion that genuinely answers the question.
# B: a conference clip that says "product" once and answers nothing.
# C: an unrelated meeting, which the old top-k returned anyway.
STRONG = [
    row("mtg_a", 0, "we should improve support around the major industry events", 0.613),
    row("mtg_a", 1, "each stage highlights three significant improvements", 0.631),
    row("mtg_a", 2, "monthly active users tell us which features deserve emphasis", 0.652),
    row("mtg_a", 3, "customer demand is the other signal for prioritisation", 0.664),
    row("mtg_a", 4, "competitor positioning centred on speed and reduced risk", 0.680),
]
WEAK = [row("mtg_b", 0, "come and see our product at the conference next week", 0.780)]
UNRELATED = [
    row("mtg_c", 0, "the sourdough starter needs feeding twice a day", 0.881),
    row("mtg_c", 1, "brake pads on the estate car are due for replacement", 0.913),
]

QUESTION = "What were the key product features highlighted?"


def select(rows, **overrides):
    kwargs = dict(
        limit=10,
        max_distance=MAX_DISTANCE,
        margin=MARGIN,
        minimum=MINIMUM,
        lexical_weight=0.25,
        duplicate_similarity=0.8,
        per_meeting_cap=3,
        workspace=True,
    )
    kwargs.update(overrides)
    return retrieval.select(rows, QUESTION, **kwargs)


# --- the ceiling ------------------------------------------------------------ #

def test_an_unrelated_meeting_is_not_evidence():
    kept = select(STRONG + UNRELATED)

    meetings = {c.meeting_id for c in kept}
    assert "mtg_a" in meetings
    # The whole point. Before this, the sourdough passage was retrieved, put in
    # the prompt and returned as a citation, because it was the third-nearest
    # thing the archive had.
    assert "mtg_c" not in meetings


def test_nothing_relevant_returns_nothing_at_all():
    kept = select(UNRELATED)

    # Not "the best of a bad set". An empty result is what lets the chat say it
    # could not find something, which is a better answer than a confident one
    # assembled out of the least-unrelated passages in the archive.
    assert kept == []


def test_the_ceiling_is_not_set_where_it_would_reject_everything():
    """The failure mode of picking this number by intuition.

    Anyone reaching for "high similarity" puts the cutoff around 0.3. Every
    passage here is real and relevant and the nearest one is 0.613, so that
    setting returns nothing for every question ever asked — a filter that looks
    principled and silently switches the product off.
    """
    assert all(r[7] > 0.5 for r in STRONG)
    assert select(STRONG) != []


# --- the margin ------------------------------------------------------------- #

def test_a_measurably_weaker_meeting_drops_out():
    kept = select(STRONG + WEAK)

    # 0.780 clears the ceiling and is still 0.167 behind the leader. It is the
    # "two short clips matched on 'product'" from the bug report: real, present,
    # and not what the question was about.
    assert {c.meeting_id for c in kept} == {"mtg_a"}


def test_the_margin_cannot_starve_a_diffuse_question():
    """A broad question has a long shallow gradient and no leader.

    Trimming that to whatever sits within 0.12 of the best would answer "what
    did we talk about?" from one passage. The minimum is the guard, and it
    applies after the ceiling — so it can rescue a thin answer but never an
    irrelevant one.
    """
    spread = [
        row("mtg_a", 0, "pricing discussion opened the call", 0.60),
        row("mtg_a", 1, "hiring plans for the next quarter", 0.75),
        row("mtg_a", 2, "the migration timeline slipped again", 0.79),
    ]

    kept = select(spread)

    assert len(kept) == MINIMUM


def test_the_minimum_does_not_resurrect_what_the_ceiling_rejected():
    kept = select(UNRELATED + WEAK)

    # One survivor of the ceiling, and the minimum wants three. It must not go
    # back for the sourdough.
    assert [c.meeting_id for c in kept] == ["mtg_b"]


# --- crowding --------------------------------------------------------------- #

def test_one_talkative_meeting_does_not_take_every_slot():
    everything = STRONG + [
        row("mtg_d", 0, "the roadmap review covered feature sequencing", 0.640),
        row("mtg_e", 0, "we highlighted the new export feature to customers", 0.645),
    ]

    kept = select(everything, per_meeting_cap=2)

    counts: dict[str, int] = {}
    for c in kept:
        counts[c.meeting_id] = counts.get(c.meeting_id, 0) + 1
    assert counts["mtg_a"] == 2
    # A workspace question wants the workspace's answer. Without the cap the
    # five-chunk meeting fills the context and the two meetings that would have
    # made this a synthesis never appear — not because they were worse, because
    # they were shorter.
    assert set(counts) == {"mtg_a", "mtg_d", "mtg_e"}


def test_one_meeting_is_never_capped_against_itself():
    """Single-meeting chat has no crowding to prevent."""
    subjects = ["pricing", "hiring", "migration", "roadmap", "renewal", "latency"]
    rows = [(i, f"we discussed {s} at length", 0.0, 1.0, 0.5) for i, s in enumerate(subjects)]

    kept = retrieval.select(
        rows, QUESTION, limit=10, max_distance=MAX_DISTANCE, margin=MARGIN,
        minimum=MINIMUM, lexical_weight=0.25, duplicate_similarity=0.8,
        per_meeting_cap=2, workspace=False,
    )

    assert len(kept) == 6


def test_near_identical_passages_collapse():
    same = "we agreed to ship the billing migration before the end of the quarter"
    rows = [
        row("mtg_a", 0, same, 0.60),
        row("mtg_a", 1, same + " and", 0.61),
        row("mtg_a", 2, "hiring for the platform team is paused", 0.62),
    ]

    kept = select(rows, per_meeting_cap=0)

    # Chunks overlap by design so consecutive ones share text. Two passages that
    # are eighty per cent the same words spend two slots of the context window
    # saying one thing, and cite the same moment twice.
    assert len(kept) == 2


# --- reranking -------------------------------------------------------------- #

def test_an_exact_word_outranks_a_marginally_nearer_neighbour():
    """What embeddings are worst at, and why the lexical term exists.

    "Stripe", "Kafka", "JWT" and somebody's surname are all words where being
    near the right meaning is not the same as being the right word.
    """
    rows = [
        row("mtg_a", 0, "we talked about the payment provider at some length", 0.640),
        row("mtg_b", 0, "the Stripe migration is blocked on their webhook change", 0.650),
    ]

    kept = retrieval.select(
        rows, "What is blocking the Stripe migration?", limit=10,
        max_distance=MAX_DISTANCE, margin=MARGIN, minimum=1,
        lexical_weight=0.25, duplicate_similarity=0.8,
        per_meeting_cap=3, workspace=True,
    )

    assert kept[0].meeting_id == "mtg_b"


def test_a_named_person_is_promoted_and_not_required():
    rows = [
        row("mtg_a", 0, "the pricing tiers were left as they are", 0.640),
        row("mtg_b", 0, "Sarah argued the pricing should move up a band", 0.660),
    ]

    kept = retrieval.select(
        rows, "What did Sarah say about pricing?", limit=10,
        max_distance=MAX_DISTANCE, margin=MARGIN, minimum=1,
        lexical_weight=0.25, duplicate_similarity=0.8, per_meeting_cap=3,
        workspace=True, boost_terms={"sarah"}, boost=0.15,
    )

    assert kept[0].meeting_id == "mtg_b"
    # Promoted, not filtered to. A transcript that spells a name differently, or
    # where diarization never resolved it, must still be able to answer.
    assert len(kept) == 2


def test_the_boost_cannot_rescue_an_irrelevant_passage():
    kept = retrieval.select(
        UNRELATED, "What did Sarah say about pricing?", limit=10,
        max_distance=MAX_DISTANCE, margin=MARGIN, minimum=MINIMUM,
        lexical_weight=0.25, duplicate_similarity=0.8, per_meeting_cap=3,
        workspace=True, boost_terms={"sourdough"}, boost=0.15,
    )

    # The ceiling runs on raw distance, before any score exists. A passage can
    # pick up lexical points for repeating the question's words while being
    # about nothing of the sort, and this is the one gate that must not be
    # talked round.
    assert kept == []


# --- diagnostics ------------------------------------------------------------ #

def test_the_report_counts_what_happened_and_names_nothing():
    report = RetrievalReport(mode="express", intent="fact")

    select(STRONG + WEAK + UNRELATED, report=report)

    assert report.considered == 8
    assert report.dropped_unrelated == 2
    assert report.kept > 0
    assert report.meetings == 1
    # Counts and distances only. These lines land in log aggregators, and a
    # transcript must not.
    blob = str(report.as_dict())
    assert "sourdough" not in blob
    assert "MTG_A" not in blob


def test_tokens_ignore_the_words_every_question_contains():
    assert retrieval.tokens("What did we decide about the pricing?") == {"decide", "pricing"}


def test_lexical_score_is_the_share_of_the_question_found():
    q = retrieval.tokens("Stripe migration blockers")
    assert retrieval.lexical_score(q, "the Stripe migration is blocked") == 2 / 3
    assert retrieval.lexical_score(q, "nothing of the sort") == 0.0
