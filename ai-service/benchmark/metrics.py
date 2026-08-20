"""Transcription quality, as numbers rather than as an impression.

The claim "this is better" is worth nothing without a way to check it, and the
way people usually check it — reading two transcripts side by side — reliably
prefers whichever one they looked at second. This module is the alternative.

## The metrics, and what each one is blind to

``WER``
    Word Error Rate: edits (substitute, insert, delete) per reference word.
    The standard number, and the one that says nothing at all about *who* said
    what. A transcript with perfect words and every speaker swapped scores a
    flawless 0.

``CER``
    The same over characters. Useful where WER is too coarse to see a change —
    proper nouns, acronyms, short recordings — because one wrong letter in
    "pgvector" costs a whole word in WER and a fortieth of one here.

``cpWER``
    Concatenated minimum-permutation WER. Group every word by speaker on both
    sides, try every mapping of hypothesis speakers onto reference speakers,
    and keep the best. **This is the number a meeting product lives on**: it is
    the one that goes up when the words are right and the attribution is wrong,
    which is exactly the failure users report as "the transcript is wrong".

``speaker count``
    Whether diarization found the right number of people. Blunt, and the
    fastest way to see a regression: two people heard as four is visible here
    before it is visible anywhere else.

``timestamp drift``
    Median absolute difference between where the reference says a turn starts
    and where the hypothesis does, over turns that were matched. This is what
    catches the failure the browser preview had — words correct, placed six
    seconds late.

Everything here is pure and works on plain strings, so it runs in CI against a
fixture without a key, a network, or an audio file.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from itertools import permutations

__all__ = [
    "Turn",
    "Scorecard",
    "normalise",
    "tokenise",
    "edit_distance",
    "wer",
    "cer",
    "cpwer",
    "speaker_counts",
    "timestamp_drift",
    "score",
]


@dataclass(frozen=True)
class Turn:
    """One attributed stretch of speech, from either transcript."""

    speaker: str
    text: str
    #: Seconds into the recording. None where a reference does not carry them.
    start: float | None = None


@dataclass
class Scorecard:
    """Every number one comparison produced. Lower is better throughout."""

    wer: float
    cer: float
    cpwer: float
    reference_speakers: int
    hypothesis_speakers: int
    reference_words: int
    hypothesis_words: int
    #: Median absolute timestamp error in seconds, or None when untestable.
    timestamp_drift: float | None = None
    #: Best speaker mapping found by cpWER: hypothesis label -> reference label.
    speaker_mapping: dict[str, str] = field(default_factory=dict)

    @property
    def speaker_count_correct(self) -> bool:
        return self.reference_speakers == self.hypothesis_speakers

    def as_row(self) -> dict[str, object]:
        return {
            "wer": round(self.wer, 4),
            "cer": round(self.cer, 4),
            "cpwer": round(self.cpwer, 4),
            "reference_speakers": self.reference_speakers,
            "hypothesis_speakers": self.hypothesis_speakers,
            "speaker_count_correct": self.speaker_count_correct,
            "reference_words": self.reference_words,
            "hypothesis_words": self.hypothesis_words,
            "timestamp_drift_seconds": (
                None if self.timestamp_drift is None else round(self.timestamp_drift, 2)
            ),
        }


# --------------------------------------------------------------------------- #
# Normalisation
# --------------------------------------------------------------------------- #

_PUNCTUATION = re.compile(r"[^\w\s']", re.UNICODE)
_WHITESPACE = re.compile(r"\s+")

#: Written and spoken forms of the same thing, which no transcriber should be
#: penalised for choosing between. Kept deliberately short: every entry is a
#: judgement about what "the same" means, and a long list quietly turns the
#: benchmark into a measure of how well the list was written.
_EQUIVALENTS = {
    "okay": "ok",
    "alright": "all right",
    "cannot": "can not",
    "gonna": "going to",
    "wanna": "want to",
    "'til": "till",
}


def normalise(text: str) -> str:
    """Strip everything a transcriber should not be scored on.

    Case, punctuation and accents go. Filler words and hesitations stay: a
    transcriber that drops "um" is producing a different transcript from one
    that keeps it, and which is better is a product decision, not a scoring
    one — so the benchmark measures it rather than hiding it.
    """
    folded = unicodedata.normalize("NFKD", text)
    folded = "".join(ch for ch in folded if not unicodedata.combining(ch))
    folded = folded.lower()
    folded = _PUNCTUATION.sub(" ", folded)
    words = [_EQUIVALENTS.get(w, w) for w in _WHITESPACE.split(folded) if w]
    return " ".join(" ".join(words).split())


def tokenise(text: str) -> list[str]:
    normalised = normalise(text)
    return normalised.split() if normalised else []


# --------------------------------------------------------------------------- #
# Edit distance
# --------------------------------------------------------------------------- #

def edit_distance(reference: list[str], hypothesis: list[str]) -> int:
    """Levenshtein distance, two rows at a time.

    The full matrix for an hour of speech is roughly ten thousand squared —
    a hundred million cells, several gigabytes in Python objects. Two rows is
    the same answer in linear memory, and the traceback is not needed because
    nothing here reports *which* words were wrong.
    """
    if not reference:
        return len(hypothesis)
    if not hypothesis:
        return len(reference)

    previous = list(range(len(hypothesis) + 1))
    for i, ref_word in enumerate(reference, start=1):
        current = [i]
        for j, hyp_word in enumerate(hypothesis, start=1):
            current.append(min(
                previous[j] + 1,                                    # deletion
                current[j - 1] + 1,                                 # insertion
                previous[j - 1] + (ref_word != hyp_word),           # substitution
            ))
        previous = current
    return previous[-1]


def _rate(reference: list[str], hypothesis: list[str]) -> float:
    """Errors per reference unit, capped at 1.0.

    Uncapped, a transcriber that hallucinates ten times the words scores 10.0
    and drags any average into nonsense. Capping loses the ability to
    distinguish "very bad" from "extremely bad", which is not a distinction
    anybody acts on.
    """
    if not reference:
        return 0.0 if not hypothesis else 1.0
    return min(1.0, edit_distance(reference, hypothesis) / len(reference))


def wer(reference: str, hypothesis: str) -> float:
    return _rate(tokenise(reference), tokenise(hypothesis))


def cer(reference: str, hypothesis: str) -> float:
    return _rate(list(normalise(reference).replace(" ", "")),
                 list(normalise(hypothesis).replace(" ", "")))


# --------------------------------------------------------------------------- #
# Speaker-attributed error
# --------------------------------------------------------------------------- #

#: Above this many distinct speakers, every permutation is too many. 8! is
#: 40320 comparisons and still fast; 12! is half a billion and is not.
MAX_PERMUTED_SPEAKERS = 8


def _by_speaker(turns: list[Turn]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for turn in turns:
        out.setdefault(turn.speaker, []).extend(tokenise(turn.text))
    return out


def cpwer(reference: list[Turn], hypothesis: list[Turn]) -> tuple[float, dict[str, str]]:
    """Concatenated minimum-permutation WER, and the mapping that achieved it.

    Speaker *labels* are arbitrary — the reference's "Speaker 1" and the
    provider's "A" have no reason to be the same person — so every assignment
    is tried and the best is kept. That is what makes this comparable across
    providers, and it is why it is the number to quote.

    Returns 1.0 and an empty mapping when there is nothing to compare.
    """
    ref_groups = _by_speaker(reference)
    hyp_groups = _by_speaker(hypothesis)
    if not ref_groups:
        return (0.0 if not hyp_groups else 1.0), {}
    if not hyp_groups:
        return 1.0, {}

    ref_labels = sorted(ref_groups)
    hyp_labels = sorted(hyp_groups)
    total_reference = sum(len(w) for w in ref_groups.values())

    if len(hyp_labels) > MAX_PERMUTED_SPEAKERS or len(ref_labels) > MAX_PERMUTED_SPEAKERS:
        # Fall back to the label-blind number rather than refusing to answer.
        # Wrong-but-stated beats a crash in a benchmark nobody can run.
        flat_ref = " ".join(" ".join(w) for w in ref_groups.values())
        flat_hyp = " ".join(" ".join(w) for w in hyp_groups.values())
        return wer(flat_ref, flat_hyp), {}

    # Pad the shorter side so a hypothesis with too few or too many speakers is
    # scored rather than skipped: an unmatched reference speaker costs all of
    # their words, which is exactly the penalty a missed speaker deserves.
    best_errors: int | None = None
    best_mapping: dict[str, str] = {}
    padded_hyp = hyp_labels + [None] * max(0, len(ref_labels) - len(hyp_labels))  # type: ignore[list-item]

    for assignment in permutations(padded_hyp, len(ref_labels)):
        errors = 0
        mapping: dict[str, str] = {}
        used: set[str] = set()
        for ref_label, hyp_label in zip(ref_labels, assignment):
            ref_words = ref_groups[ref_label]
            hyp_words = hyp_groups[hyp_label] if hyp_label else []
            if hyp_label:
                mapping[hyp_label] = ref_label
                used.add(hyp_label)
            errors += edit_distance(ref_words, hyp_words)
        # Hypothesis speakers nobody matched are pure insertions.
        for leftover in hyp_labels:
            if leftover not in used:
                errors += len(hyp_groups[leftover])
        if best_errors is None or errors < best_errors:
            best_errors = errors
            best_mapping = mapping

    return min(1.0, (best_errors or 0) / total_reference), best_mapping


def speaker_counts(reference: list[Turn], hypothesis: list[Turn]) -> tuple[int, int]:
    return (
        len({t.speaker for t in reference if t.text.strip()}),
        len({t.speaker for t in hypothesis if t.text.strip()}),
    )


def timestamp_drift(reference: list[Turn], hypothesis: list[Turn]) -> float | None:
    """Median absolute error between matched turn starts, in seconds.

    Turns are matched by content rather than by position: a hypothesis with one
    extra turn near the start would otherwise be compared off-by-one for the
    rest of the meeting, and report a drift that is really a misalignment.

    None when either side carries no timestamps, or nothing matched. None is
    not zero — "we could not measure this" and "this was perfect" are opposite
    findings and must not average together.
    """
    ref_timed = [t for t in reference if t.start is not None and t.text.strip()]
    hyp_timed = [t for t in hypothesis if t.start is not None and t.text.strip()]
    if not ref_timed or not hyp_timed:
        return None

    errors: list[float] = []
    for ref in ref_timed:
        ref_words = tokenise(ref.text)
        if not ref_words:
            continue
        opening = " ".join(ref_words[:6])
        match = next(
            (h for h in hyp_timed if " ".join(tokenise(h.text)[:6]) == opening), None
        )
        if match is None or match.start is None or ref.start is None:
            continue
        errors.append(abs(match.start - ref.start))

    if not errors:
        return None
    errors.sort()
    middle = len(errors) // 2
    if len(errors) % 2:
        return errors[middle]
    return (errors[middle - 1] + errors[middle]) / 2


def score(reference: list[Turn], hypothesis: list[Turn]) -> Scorecard:
    """Every metric, from one pair of transcripts."""
    ref_text = " ".join(t.text for t in reference)
    hyp_text = " ".join(t.text for t in hypothesis)
    attributed, mapping = cpwer(reference, hypothesis)
    ref_speakers, hyp_speakers = speaker_counts(reference, hypothesis)

    return Scorecard(
        wer=wer(ref_text, hyp_text),
        cer=cer(ref_text, hyp_text),
        cpwer=attributed,
        reference_speakers=ref_speakers,
        hypothesis_speakers=hyp_speakers,
        reference_words=len(tokenise(ref_text)),
        hypothesis_words=len(tokenise(hyp_text)),
        timestamp_drift=timestamp_drift(reference, hypothesis),
        speaker_mapping=mapping,
    )
