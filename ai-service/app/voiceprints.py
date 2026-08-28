"""Matching a voice in one meeting to the same person in another.

This module is the decision half of speaker identification. It holds no audio,
loads no model and touches no database — it takes vectors that already exist
and answers one question: *is this unresolved speaker confidently the same
person as one of the profiles this user has approved?*

It is separate from the model deliberately. The embedder is a large optional
dependency (see `app.providers.ecapa_embedder`); the rule for when a match is
allowed to happen is the part that decides whether the feature is safe, so it
is written in plain Python, has no import that can fail, and is tested on its
own.

## The asymmetry this is built around

Renaming *Speaker 2* to *Sarah* when it was not Sarah is far worse than leaving
*Speaker 2* alone. A wrong name is not a cosmetic label: it is put in front of
the user as a fact, it is written into the retrieval passages, and it comes
back out of chat as "Sarah said we would ship on Friday" with a citation
underneath it. The user has no way to tell that apart from a true answer.
Leaving *Speaker 2* unresolved, by contrast, is visibly unfinished — it is the
state they were already in, and it invites the manual fix that has always been
there.

So every rule below is a way of refusing, and there is no rule anywhere that
makes a match more likely.

## The four refusals

**Too little speech.** A voiceprint computed from a second and a half of
"Exactly." is not a voiceprint, it is noise with a shape. Below
`min_seconds` a candidate is not compared against anything at all, because a
short sample is not merely less accurate — it drifts toward the middle of the
embedding space, so it is *plausibly close to everybody*, which is the worst
possible input to a nearest-neighbour rule.

**Not similar enough.** The best profile must clear an absolute threshold.

**Not distinctly the best.** The best profile must beat the runner-up by a
margin. This is the check that handles two siblings, two colleagues with
similar voices, or a profile built from a bad sample. If the top two are close
together the honest answer is "one of these two", and there is no way to say
that in a transcript — so nothing is said. Note the runner-up is measured
against *every* profile including ones already claimed in this pass, because
the ambiguity is a property of the voice, not of the assignment.

**Somebody else got there first.** One person cannot be two speakers in the
same meeting, so a profile is claimed at most once. A candidate that loses a
profile to a better-matching candidate is **not** given its second choice —
that would be answering "who else could this be?", which is exactly the
guessing this module exists to prevent. It goes unresolved.

## What is deliberately not here

No fallback to "the closest profile" when nothing clears the bar. No decay of
the threshold when a meeting has only one unresolved speaker. No use of the
speaker number, the meeting date, the other speakers present, or anything at
all from the transcript text. Nothing in this file has ever seen a word of what
was said, and that is on purpose: identity is an acoustic question, and a
matcher that reads the transcript will eventually decide that whoever was
called "Sarah" out loud must be the voice that answered.

## Why no percentage is returned to the user

`similarity` is a cosine between two embeddings. It is a real number and it is
the right number to threshold on, but it is **not a calibrated probability** —
0.71 does not mean "71% likely to be Sarah", and the mapping from cosine to
likelihood depends on the model, the recording conditions and how much speech
went into each side. Showing it as a confidence percentage would invent a
precision the matcher does not have, so it stays internal: it is logged, it is
tested, and the user is told a count.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Iterable, Sequence

#: ECAPA-TDNN speaker embeddings. Pinned here rather than inferred so a model
#: swap that changes the width fails loudly against the `vector(192)` column
#: instead of writing truncated vectors that still compare to something.
EMBEDDING_DIM = 192


@dataclass(frozen=True)
class Candidate:
    """One unresolved speaker in one meeting, reduced to a vector.

    `speaker_key` is the meeting-local canonical identity (`spk_2`), never the
    display name and never the provider's cluster letter. It is the only handle
    that survives a rename, which is what makes "apply this to every turn by
    that speaker" a single well-defined operation.
    """

    speaker_key: str
    embedding: Sequence[float]
    speech_seconds: float


@dataclass(frozen=True)
class Profile:
    """A voice the user has explicitly named, at least once, in some meeting."""

    profile_id: str
    display_name: str
    embedding: Sequence[float]
    sample_count: int = 1


@dataclass(frozen=True)
class Match:
    """A proposal that cleared every refusal above."""

    speaker_key: str
    profile_id: str
    display_name: str
    #: Cosine against the winning profile. Diagnostic; not a probability.
    similarity: float
    #: Cosine against the next best profile, or None when there was only one.
    runner_up: float | None


@dataclass(frozen=True)
class Thresholds:
    """The three numbers that decide whether anything happens at all.

    Defaults are conservative on purpose and are documented in
    `docs/speaker-identification.md` alongside the measurements they came from.
    They are settings rather than constants because the right values depend on
    the embedding model, and pinning them in code would mean a model swap
    silently reused numbers calibrated for a different one.
    """

    accept: float = 0.55
    margin: float = 0.08
    min_seconds: float = 6.0


def l2_normalise(vec: Sequence[float]) -> list[float]:
    """Scale to unit length, so cosine similarity is a plain dot product.

    A zero vector is returned unchanged rather than raising: it can only come
    from an embedder that failed, and the matcher's job is to refuse such a
    candidate (its similarity to everything is 0.0, which clears nothing), not
    to crash the request that contained it.
    """
    norm = math.sqrt(sum(float(v) * float(v) for v in vec))
    if norm == 0.0:
        return [float(v) for v in vec]
    return [float(v) / norm for v in vec]


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    """Cosine similarity in [-1, 1]; 0.0 for a mismatched or empty pair.

    Length mismatch returns 0.0 rather than raising. It means two embedders
    have been mixed — a real bug, but one whose safe reading is "these are not
    comparable", and refusing to compare is the failure that cannot rename
    somebody.
    """
    if not a or not b or len(a) != len(b):
        return 0.0
    na, nb = l2_normalise(a), l2_normalise(b)
    dot = sum(x * y for x, y in zip(na, nb))
    # Clamped because floating-point error puts a vector against itself at
    # 1.0000000000000002, and a "similarity" that can exceed 1 is a trap for
    # anything downstream that formats it or feeds it to acos.
    return max(-1.0, min(1.0, dot))


def centroid(vectors: Iterable[Sequence[float]]) -> list[float]:
    """The mean of several embeddings of the same voice, re-normalised.

    Averaging is what makes a profile improve with use: each new sample was
    recorded in different conditions, and the component they share is the
    speaker. Re-normalising afterwards matters because the mean of unit vectors
    is not a unit vector, and an un-normalised profile would score lower against
    everything purely because it is shorter.
    """
    rows = [l2_normalise(v) for v in vectors if v]
    if not rows:
        return []
    width = len(rows[0])
    if any(len(r) != width for r in rows):
        raise ValueError("cannot average embeddings of different widths")
    mean = [sum(r[i] for r in rows) / len(rows) for i in range(width)]
    return l2_normalise(mean)


def match_speakers(
    candidates: Sequence[Candidate],
    profiles: Sequence[Profile],
    *,
    thresholds: Thresholds | None = None,
    taken_names: frozenset[str] = frozenset(),
) -> list[Match]:
    """Assign profiles to unresolved speakers, or to nobody.

    `taken_names` is the set of display names already in use in this meeting,
    case-folded — the speakers the user named by hand and the ones an earlier
    rematch resolved. A profile whose name is already on somebody else's turns
    is skipped, because the alternative is a transcript with two people called
    Sarah in it, which reads as a bug even in the case where it is arguably
    correct.

    Returns matches in descending order of similarity. A candidate absent from
    the result stays exactly as it was; there is no "unmatched" outcome to
    handle, which is the point.
    """
    limits = thresholds or Thresholds()
    blocked = {n.strip().casefold() for n in taken_names if n and n.strip()}

    proposals: list[Match] = []
    for cand in candidates:
        # Refusal 1: too little speech to have a voiceprint worth comparing.
        if cand.speech_seconds < limits.min_seconds:
            continue

        scored = sorted(
            ((cosine(cand.embedding, p.embedding), p) for p in profiles),
            key=lambda pair: pair[0],
            reverse=True,
        )
        if not scored:
            continue

        best_score, best = scored[0]
        runner_up = scored[1][0] if len(scored) > 1 else None

        # Refusal 2: not similar enough to anybody.
        if best_score < limits.accept:
            continue
        # Refusal 3: not distinctly the best. Measured against every profile,
        # including ones another candidate will win, because two close
        # candidates mean the voice is ambiguous however the assignment lands.
        if runner_up is not None and (best_score - runner_up) < limits.margin:
            continue

        proposals.append(
            Match(
                speaker_key=cand.speaker_key,
                profile_id=best.profile_id,
                display_name=best.display_name,
                similarity=best_score,
                runner_up=runner_up,
            )
        )

    # Refusal 4: one profile, one speaker. Strongest proposal wins it; the
    # loser is dropped rather than handed its second choice.
    proposals.sort(key=lambda m: m.similarity, reverse=True)
    claimed_profiles: set[str] = set()
    claimed_keys: set[str] = set()
    accepted: list[Match] = []
    for proposal in proposals:
        if proposal.profile_id in claimed_profiles:
            continue
        if proposal.speaker_key in claimed_keys:
            continue
        if proposal.display_name.strip().casefold() in blocked:
            continue
        claimed_profiles.add(proposal.profile_id)
        claimed_keys.add(proposal.speaker_key)
        accepted.append(proposal)

    return accepted


#: Display names that mean "not resolved", not "a person called this".
#:
#: An exact shape rather than a prefix, and the difference is a bug that was
#: caught by a test rather than by a user: "speaker " as a prefix also matches
#: **"Speaker of the House"**, so a rematch would have overwritten a name
#: somebody deliberately typed. Only the three forms Orion itself generates
#: are up for grabs, and each must match end to end.
_UNRESOLVED = re.compile(r"^(speaker\s+\d+|spk_\d+|unknown speaker)$", re.IGNORECASE)


def is_unresolved(display_name: str | None) -> bool:
    """Whether this label is still a placeholder rather than a person.

    Matches the labels Orion itself generates — "Speaker 1", "spk_2",
    "Unknown speaker" — and nothing else. It is deliberately not "does this look
    like a name": somebody who renames a speaker to "Facilitator",
    "Interviewer 2" or "Speaker of the House" has made a decision about their own
    transcript, and a cleverer test would decide those were placeholders and
    spend its time undoing users' work.
    """
    if not display_name:
        # An empty label is an unattributed turn. It has no voice of its own to
        # match on, and the caller filters it out before it gets here; treating
        # it as unresolved here would be a second, quieter place to change that.
        return False
    return _UNRESOLVED.match(display_name.strip()) is not None
