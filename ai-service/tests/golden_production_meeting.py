"""The human-verified production meeting, as a fixture both algorithms can run.

Built from the timeline in the regression report rather than from synthetic
shapes, because synthetic micro-tests passed while production got worse — which
is the whole reason this file exists. Every row carries three things:

    when it starts, what the provider called it, and who really spoke.

The provider labels are the ones consistent with both observed transcripts, and
the acoustic truth is the human verification. Where the two disagree, that row
*is* a provider error and is the thing under test.

Nothing here reads the words. The text column exists so a failure report is
legible to a person; no rule may consult it.
"""

from __future__ import annotations

from app.schemas import Segment, Word
from app.voiceprints import EMBEDDING_DIM, l2_normalise
import math
import random


def _voice(seed: int) -> list[float]:
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


#: The people actually in the room. Brian and Speaker 5 are deliberately near
#: each other in the space -- real meetings contain voices a model finds
#: similar, and a fixture where everyone is orthogonal proves nothing about
#: merging.
SYDNEY, S1, S3, S4, S5, BRIAN = (_voice(n) for n in (11, 12, 13, 14, 15, 16))


def mm(text: str) -> float:
    """`m:ss` as seconds."""
    minutes, seconds = text.split(":")
    return int(minutes) * 60 + int(seconds)


#: `(start, duration, provider_label, acoustic_truth, human_label, note)`
#:
#: `human_label` is what the transcript should say. `acoustic_truth` is whose
#: voice is really in the audio; the two differ only in that one is a name for
#: the other.
TIMELINE = [
    (mm("1:13"),  4.0,  "A", SYDNEY, "Sydney",    ""),
    (mm("1:17"),  0.5,  "C", S1,     "Speaker 1", "fragment: provider says C, really S1"),
    (mm("1:18"), 41.0,  "B", S1,     "Speaker 1", ""),
    (mm("1:59"),  3.0,  "C", S3,     "Speaker 3", ""),
    (mm("2:02"),  2.0,  "D", S4,     "Speaker 4", "leading fragment of one S4 turn"),
    (mm("2:04"), 13.0,  "D", S4,     "Speaker 4", ""),
    (mm("2:18"), 15.0,  "B", S1,     "Speaker 1", ""),
    (mm("2:33"),  4.0,  "F", S1,     "Speaker 1", "cadence: provider says F, really S1"),
    (mm("2:37"),  6.0,  "C", S3,     "Speaker 3", ""),
    (mm("2:43"), 18.0,  "B", S1,     "Speaker 1", ""),
    (mm("3:01"),  1.0,  "C", S3,     "Speaker 3", ""),
    (mm("3:02"),  2.0,  "D", S4,     "Speaker 4", ""),
    (mm("3:04"),  2.0,  "B", S1,     "Speaker 1", "leading fragment of one S1 turn"),
    (mm("3:06"), 57.0,  "B", S1,     "Speaker 1", ""),
    (mm("4:03"), 60.0,  "A", SYDNEY, "Sydney",    ""),
    # Two short, clean turns of Brian's. Without them, label F's only short turn
    # is the mislabelled cadence line at 2:33 — so F's reference gets built from
    # Speaker 1's voice, F and B come out identical, and the "too alike to
    # judge" gate declines the entire meeting. The first version of this fixture
    # did exactly that, and it is a real fragility worth remembering: preferring
    # short turns can build a speaker's whole reference out of one mislabelled
    # fragment.
    (mm("6:30"),  4.0,  "F", BRIAN,  "Brian",     ""),
    (mm("7:05"),  3.0,  "F", BRIAN,  "Brian",     ""),
    (mm("7:10"), 85.0,  "F", BRIAN,  "Brian",     ""),
    (mm("8:35"),  0.5,  "C", BRIAN,  "Brian",     "fragment: provider says C, really Brian"),
    (mm("8:36"), 21.0,  "F", BRIAN,  "Brian",     ""),
    (mm("8:57"),  0.6,  "C", BRIAN,  "Brian",     "fragment: provider says C, really Brian"),
    (mm("8:58"), 10.0,  "F", BRIAN,  "Brian",     ""),
    (mm("9:08"), 24.0,  "C", S3,     "Speaker 3", ""),
    (mm("9:32"), 49.0,  "D", S5,     "Speaker 5", "same label D as S4, different person"),
    (mm("10:21"), 5.0,  "B", S1,     "Speaker 1", ""),
    (mm("10:26"), 30.0, "F", BRIAN,  "Brian",     ""),
]


def build():
    """`(segments, sampler_factory, expected)` for the meeting above.

    Canonical numbering is applied the way `parse_response` applies it: by first
    appearance of the provider label, which is the state the refiner is handed.
    """
    order: dict[str, int] = {}
    segments, spans, expected = [], [], []
    for start, seconds, label, voice, human, note in TIMELINE:
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
        spans.append((start, start + seconds, voice))
        expected.append(human)
    return segments, _sampler(spans), expected


def _sampler(spans):
    """Audio, as a function from a span to a voice vector.

    Returns None below the embedder's own floor, exactly as the real sampler
    does -- `ecapa_embedder.embed` refuses rather than answering for a stretch
    it cannot judge, and a fixture that answered anyway would test a path
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
            total = sum(w for w, _ in weighted)
            mixed = [0.0] * EMBEDDING_DIM
            for weight, vec in weighted:
                for i, value in enumerate(vec):
                    mixed[i] += (weight / total) * value
            return l2_normalise(mixed)

        return sample

    return build


def stamp(seconds: float) -> str:
    return f"{int(seconds) // 60}:{int(seconds) % 60:02d}"
