"""Measuring diarization, so a change can be shown to be an improvement.

<h2>Why word-level and not DER</h2>

Diarization Error Rate is the standard, and it is the wrong headline for this
product. DER measures seconds of misattributed *audio*; Orion renders
*words*. A model can win on DER by getting long stretches right while losing
every one-word interjection, and the interjections are the complaint. So the
headline here is **word attribution accuracy** — of the words a human labelled,
what fraction got the right speaker — with boundary counts beside it, because
one number cannot distinguish "merged two people" from "split one".

<h2>Mapping anonymous labels to truth</h2>

Every system involved invents its own names: AssemblyAI says ``A``/``B``,
a diarizer says ``D0``/``D1``, Orion says ``spk_1``/``spk_2``, and the human
label says ``alice``/``bob``. None of them can be compared directly.

The standard fix is an optimal one-to-one assignment between hypothesis and
reference labels, chosen to maximise agreement — the same idea behind DER's
speaker mapping and cpWER's permutation search. With the handful of speakers a
meeting has, the exhaustive permutation is cheap and exact, so there is no
reason to approximate it.

An assignment is one-to-one on purpose. Letting two hypothesis labels both map
to ``alice`` would score a system that split her in half as perfect.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from itertools import permutations


@dataclass(frozen=True)
class LabelledWord:
    """A word with the speaker a human says produced it."""

    text: str
    start: float
    end: float
    speaker: str


@dataclass
class Scores:
    """One system's performance on one fixture."""

    system: str
    fixture: str
    words: int = 0
    correct: int = 0
    unresolved: int = 0
    #: |hypothesis speakers| - |reference speakers|. Signed: +1 invented one.
    speaker_count_error: int = 0
    reference_speakers: int = 0
    hypothesis_speakers: int = 0
    #: True speaker changes the system did not draw.
    missed_boundaries: int = 0
    #: Changes it drew where the truth had none.
    false_boundaries: int = 0
    #: Reference speaker -> what it was most often called.
    confusion: dict[str, dict[str, int]] = field(default_factory=dict)

    @property
    def attribution(self) -> float:
        """Fraction of reference words given the right speaker."""
        return self.correct / self.words if self.words else 0.0

    @property
    def cpwer(self) -> float:
        """Concatenated minimum-permutation word error, restricted to speakers.

        The words themselves never change in this pipeline — reconciliation
        moves attribution, not text — so the only errors cpWER can see here are
        substitutions of a word into the wrong speaker's stream. That makes it
        exactly ``1 - attribution`` for our purposes, and it is reported under
        its usual name so the number is comparable to published figures rather
        than being a private metric.
        """
        return 1.0 - self.attribution

    def row(self) -> dict[str, object]:
        return {
            "system": self.system,
            "fixture": self.fixture,
            "attribution": round(self.attribution, 4),
            "cpwer": round(self.cpwer, 4),
            "speaker_count_error": self.speaker_count_error,
            "missed_boundaries": self.missed_boundaries,
            "false_boundaries": self.false_boundaries,
            "unresolved": self.unresolved,
        }


def best_mapping(
    reference: list[str], hypothesis: list[str | None]
) -> dict[str, str]:
    """One-to-one hypothesis→reference assignment maximising agreement.

    Exhaustive over permutations, which is exact and, at the speaker counts a
    meeting has, faster than being clever about it. Unresolved words (None) take
    part in nothing: they are counted separately rather than being allowed to
    influence which mapping wins.
    """
    ref_labels = sorted({r for r in reference})
    hyp_labels = sorted({h for h in hypothesis if h is not None})
    if not hyp_labels:
        return {}

    # Pair the smaller set against every choice from the larger one.
    if len(hyp_labels) <= len(ref_labels):
        best, score = {}, -1
        for chosen in permutations(ref_labels, len(hyp_labels)):
            candidate = dict(zip(hyp_labels, chosen))
            agreed = sum(
                1 for r, h in zip(reference, hypothesis)
                if h is not None and candidate.get(h) == r
            )
            if agreed > score:
                best, score = candidate, agreed
        return best

    best, score = {}, -1
    for chosen in permutations(hyp_labels, len(ref_labels)):
        candidate = {h: r for h, r in zip(chosen, ref_labels)}
        agreed = sum(
            1 for r, h in zip(reference, hypothesis)
            if h is not None and candidate.get(h) == r
        )
        if agreed > score:
            best, score = candidate, agreed
    return best


def score(
    system: str,
    fixture: str,
    truth: list[LabelledWord],
    hypothesis: list[str | None],
) -> Scores:
    """Compare one system's per-word answers against the human labels.

    ``hypothesis`` is parallel to ``truth`` — one entry per reference word, None
    where the system declined. Callers align by index rather than by time,
    because every system under test is being fed the same word list; a system
    that changed the words would be failing a different test than this one.
    """
    if len(hypothesis) != len(truth):
        raise ValueError(f"{len(hypothesis)} answers for {len(truth)} words")

    reference = [w.speaker for w in truth]
    mapping = best_mapping(reference, hypothesis)

    out = Scores(
        system=system,
        fixture=fixture,
        words=len(truth),
        reference_speakers=len(set(reference)),
        hypothesis_speakers=len({h for h in hypothesis if h is not None}),
    )
    out.speaker_count_error = out.hypothesis_speakers - out.reference_speakers

    for want, got in zip(reference, hypothesis):
        if got is None:
            out.unresolved += 1
            # Unresolved is not correct, and it is not confusion either. It is
            # counted on its own so a cautious system and a confidently wrong
            # one cannot produce the same headline number.
            out.confusion.setdefault(want, {}).setdefault("unresolved", 0)
            out.confusion[want]["unresolved"] += 1
            continue
        heard = mapping.get(got, got)
        out.confusion.setdefault(want, {}).setdefault(heard, 0)
        out.confusion[want][heard] += 1
        if heard == want:
            out.correct += 1

    out.missed_boundaries, out.false_boundaries = _boundaries(reference, hypothesis, mapping)
    return out


def _boundaries(
    reference: list[str], hypothesis: list[str | None], mapping: dict[str, str]
) -> tuple[int, int]:
    """Speaker changes between consecutive words: missed, and invented.

    A change next to an unresolved word is counted as neither. The system did
    not claim there was a boundary and did not claim there was not one; scoring
    it either way would be inventing an opinion it declined to hold.
    """
    missed = false = 0
    for i in range(1, len(reference)):
        truth_changed = reference[i] != reference[i - 1]
        left, right = hypothesis[i - 1], hypothesis[i]
        if left is None or right is None:
            continue
        said_changed = mapping.get(left, left) != mapping.get(right, right)
        if truth_changed and not said_changed:
            missed += 1
        elif said_changed and not truth_changed:
            false += 1
    return missed, false


def table(rows: list[Scores]) -> str:
    """The §15 comparison, as fixed-width text for a terminal or a report."""
    if not rows:
        return "(no results)"
    systems = sorted({r.system for r in rows}, key=lambda s: [x.system for x in rows].index(s))
    fixtures = sorted({r.fixture for r in rows}, key=lambda f: [x.fixture for x in rows].index(f))
    by = {(r.system, r.fixture): r for r in rows}

    width = max(len(f) for f in fixtures) + 2
    head = "fixture".ljust(width) + "".join(s.rjust(20) for s in systems)
    lines = [head, "-" * len(head)]
    for fixture in fixtures:
        cells = []
        for system in systems:
            r = by.get((system, fixture))
            cells.append("-".rjust(20) if r is None
                         else f"{r.attribution * 100:5.1f}%  {r.missed_boundaries:>2}m {r.false_boundaries:>2}f".rjust(20))
        lines.append(fixture.ljust(width) + "".join(cells))

    lines.append("-" * len(head))
    for system in systems:
        mine = [r for r in rows if r.system == system]
        words = sum(r.words for r in mine)
        correct = sum(r.correct for r in mine)
        overall = correct / words if words else 0.0
        lines.append(
            f"{system}: attribution {overall * 100:.1f}%  cpWER {(1 - overall) * 100:.1f}%  "
            f"missed {sum(r.missed_boundaries for r in mine)}  "
            f"false {sum(r.false_boundaries for r in mine)}  "
            f"unresolved {sum(r.unresolved for r in mine)}  "
            f"speaker-count error {sum(abs(r.speaker_count_error) for r in mine)}"
        )
    lines.append("")
    lines.append("Each cell: word attribution %, then missed (m) and false (f) boundaries.")
    return "\n".join(lines)
