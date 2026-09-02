"""Turning a human-verified timeline into something the refiner can run on.

Shared by the golden meetings, which differ only in their rows. Every row says
three things:

    when it starts, what the provider called it, and who really spoke.

Where the last two disagree, that row **is** a provider error and is the thing
under test. Nothing here reads the words; the text column exists so a failure
report is legible to a person, and no rule may consult it.
"""

from __future__ import annotations

import random

from app.schemas import Segment, Word
from app.voiceprints import EMBEDDING_DIM, l2_normalise

#: `(start, duration, provider_label, acoustic_truth, human_label, note)`
#:
#: `human_label` is what the transcript should say. `acoustic_truth` is whose
#: voice is really in the audio; the two differ only in that one is a name for
#: the other.
Row = tuple[float, float, str, list, str, str]


def voice(seed: int) -> list[float]:
    """A deterministic unit vector standing in for one person's voice.

    Gaussian rather than a sampled sine, and the difference is not cosmetic: two
    sines at different phases are the *same wave shifted*, so they correlate
    almost perfectly. A first version of this fixture used them and every pair
    of "different" voices scored 1.00 against each other, which made the refiner
    decline the whole meeting and made the comparison meaningless. Independent
    gaussians in 192 dimensions are near-orthogonal, which is what unrelated
    voices actually look like to this model.
    """
    rng = random.Random(seed)
    return l2_normalise([rng.gauss(0.0, 1.0) for _ in range(EMBEDDING_DIM)])


def nearby(base: list[float], other: list[float], share: float) -> list[float]:
    """A voice this model renders similarly to `base`, without being it.

    A fixture where everyone is orthogonal cannot fail a false merge, so it
    cannot prove one is impossible. Two real participants who sound alike are
    the case that makes merging dangerous, and one pair here is built to be it.
    """
    return l2_normalise([(1 - share) * a + share * b for a, b in zip(base, other)])


def mm(text: str) -> float:
    """`m:ss` as seconds."""
    minutes, seconds = text.split(":")
    return int(minutes) * 60 + int(seconds)


def stamp(seconds: float) -> str:
    return f"{int(seconds) // 60}:{int(seconds) % 60:02d}"


def grouping(out, expected) -> list[str | None]:
    """Each output speaker mapped to the person it best accounts for.

    The **optimal one-to-one assignment**, which is what `app.diareval` already
    computes for every other measurement in this repo. Label-agnostic on
    purpose: the question is whether the turns one person said end up together,
    not whether they end up under the number a human would have picked. A
    meeting that merely renumbered has not regressed.

    Mapping a speaker to whoever it happens to speak for *first* is the obvious
    alternative and it is wrong in a way that flatters the builds under test.
    One provider label in the launch meeting opens with a turn it misattributed
    and then holds four real ones; by first appearance, a build that put all
    five under one speaker scores the misattributed turn right and the four real
    ones wrong — the truth upside down, and not what the transcript shows a
    reader.

    One-to-one also means a surplus speaker maps to `None` rather than doubling
    up on somebody, so a build that split one person in half cannot score as
    though it had not.
    """
    from app.diareval import best_mapping

    hypothesis = [segment.speaker for segment in out]
    mapping = best_mapping(list(expected), hypothesis)
    return [mapping.get(label) for label in hypothesis]


def correct(out, expected) -> int:
    return sum(1 for a, b in zip(grouping(out, expected), expected) if a == b)


def assemble(timeline: list[Row]):
    """`(segments, sampler_factory, expected)` for one timeline.

    Canonical numbering is applied the way `parse_response` applies it: by first
    appearance of the provider label, which is the state the refiner is handed.
    """
    order: dict[str, int] = {}
    segments, spans, expected = [], [], []
    for start, seconds, label, speaks, human, _note in timeline:
        if label not in order:
            order[label] = len(order) + 1
        number = order[label]
        count = max(2, int(seconds * 2))
        step = seconds / count
        words = [
            Word(text=f"w{i}", start=start + i * step, end=start + (i + 1) * step,
                 speaker=f"Speaker {number}", speaker_raw=label)
            for i in range(count)
        ]
        segments.append(Segment(
            start=start, end=start + seconds,
            speaker=f"Speaker {number}", speaker_key=f"spk_{number}",
            speaker_raw=label, speaker_status="attributed",
            text=" ".join(w.text for w in words), words=words,
        ))
        spans.append((start, start + seconds, speaks))
        expected.append(human)
    return segments, sampler(spans), expected


def sampler(spans):
    """Audio, as a function from a span to a voice vector.

    Returns None below the embedder's own floor, exactly as the real sampler
    does — `ecapa_embedder.embed` refuses rather than answering for a stretch it
    cannot judge, and a fixture that answered anyway would test a path
    production never reaches.
    """
    from app.providers.ecapa_embedder import MIN_SPAN_SECONDS

    def build(_audio):
        def sample(start: float, end: float):
            if end - start < MIN_SPAN_SECONDS:
                return None
            weighted = []
            for lo, hi, vec in spans:
                overlap = max(0.0, min(end, hi) - max(start, lo))
                if overlap > 0:
                    weighted.append((overlap, vec))
            if not weighted:
                return None
            total = sum(weight for weight, _ in weighted)
            mixed = [0.0] * EMBEDDING_DIM
            for weight, vec in weighted:
                for i, value in enumerate(vec):
                    mixed[i] += (weight / total) * value
            return l2_normalise(mixed)

        return sample

    return build
