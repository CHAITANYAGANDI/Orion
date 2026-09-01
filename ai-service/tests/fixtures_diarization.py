"""The ten cases from the brief, as word lists with human labels.

<h2>Why these are synthetic and in the repository</h2>

No user audio is committed, ever. What is committed is the *structure* of each
hard case — word timings and the speaker a human says produced each word —
because that is what the reconciliation is being tested on. Given a diarization
timeline from any source, real or stubbed, these fixtures answer "did every word
end up with the right person".

That split is deliberate. The reconciler is a pure function of (words, timeline)
and can be tested exhaustively with no model and no audio, which is what makes
its behaviour at boundaries provable rather than sampled. The *model* is
measured separately, against real audio, on a machine that has the weights —
see tools/diarization_benchmark.py.

Each fixture carries the timeline a competent diarizer should produce, and the
labels AssemblyAI actually produced (or plausibly would), so the harness can
score all four systems the brief asks for against the same words.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.diarize_port import SpeakerTurn, Timeline
from app.diareval import LabelledWord


@dataclass
class Fixture:
    """One hard case, with every system's input in one place."""

    name: str
    #: What was said, when, and by whom. The ground truth.
    truth: list[LabelledWord]
    #: The provider's per-word labels, parallel to `truth`.
    provider: list[str | None]
    #: What a competent acoustic diarizer should return for this audio.
    timeline: Timeline
    note: str = ""

    @property
    def words(self) -> list[tuple[str, float, float, str | None]]:
        return [
            (w.text, w.start, w.end, raw)
            for w, raw in zip(self.truth, self.provider)
        ]


def _words(spec: list[tuple[str, float, float, str]]) -> list[LabelledWord]:
    return [LabelledWord(text=t, start=s, end=e, speaker=who) for t, s, e, who in spec]


def _timeline(turns: list[tuple[float, float, str]], model: str = "oracle") -> Timeline:
    return Timeline(
        turns=[SpeakerTurn(start=s, end=e, speaker=who) for s, e, who in turns],
        model=model,
    )


# --------------------------------------------------------------------------- #
# 1. One-word interjection. The case the 6-second floor could never reach.
# --------------------------------------------------------------------------- #
INTERJECTION = Fixture(
    name="one-word interjection",
    truth=_words([
        ("I'm", 0.00, 0.20, "alice"),
        ("done.", 0.20, 0.60, "alice"),
        ("Exactly.", 0.61, 1.05, "bob"),
        ("Let's", 1.06, 1.25, "alice"),
        ("ship", 1.25, 1.50, "alice"),
        ("it.", 1.50, 1.80, "alice"),
    ]),
    # The provider heard one voice throughout.
    provider=["A"] * 6,
    timeline=_timeline([(0.00, 0.60, "D0"), (0.60, 1.06, "D1"), (1.06, 1.80, "D0")]),
    note="The example in the brief, verbatim.",
)

# --------------------------------------------------------------------------- #
# 2. A 2-5 second handoff -- under the old floor, so previously untouchable.
# --------------------------------------------------------------------------- #
SHORT_HANDOFF = Fixture(
    name="short handoff (4.85s)",
    truth=_words([
        ("So", 0.00, 0.30, "alice"),
        ("that's", 0.30, 0.70, "alice"),  # provider switches to B from here
        ("the", 0.70, 0.85, "alice"),
        ("plan.", 0.85, 1.40, "alice"),
        ("Sounds", 1.50, 1.95, "bob"),
        ("good", 1.95, 2.30, "bob"),
        ("to", 2.30, 2.45, "bob"),
        ("me.", 2.45, 2.90, "bob"),
        ("Great,", 3.00, 3.45, "alice"),
        ("let's", 3.45, 3.75, "alice"),
        ("go.", 3.75, 4.85, "alice"),
    ]),
    # Both labels exist in the meeting, so the refiner has a reference. What
    # stops it is the length: the merged run is 4.85s, under its 6s floor.
    provider=["A"] * 2 + ["B"] * 9,
    timeline=_timeline([(0.00, 1.45, "D0"), (1.45, 2.95, "D1"), (2.95, 4.85, "D0")]),
    note="The 4.85s merged turn docs/diarization.md records as unfixable.",
)

# --------------------------------------------------------------------------- #
# 3. Zero-pause handoff. The real Mr Bob failure: gap at the boundary is 0.00.
# --------------------------------------------------------------------------- #
NO_SILENCE = Fixture(
    name="zero-pause handoff",
    truth=_words([
        # Context. The provider labelled this stretch A and was right, which is
        # what gives the old refiner a reference to work from -- as it had in
        # the real recording. Without it the comparison would be rigged.
        ("Right,", 14.00, 14.50, "alice"),
        ("I'll", 14.50, 14.80, "alice"),
        ("head", 14.80, 15.20, "alice"),
        ("off", 15.20, 15.60, "alice"),
        ("now.", 15.60, 16.20, "alice"),
        ("Okay,", 22.00, 22.40, "bob"),
        ("you", 22.40, 22.60, "bob"),
        ("have", 22.60, 22.85, "bob"),
        ("a", 22.85, 22.95, "bob"),
        ("good", 22.95, 23.35, "bob"),
        ("day", 23.35, 23.70, "bob"),
        ("anyway.", 23.70, 24.30, "bob"),
        ("I'm", 24.30, 24.55, "bob"),
        ("going", 24.55, 24.85, "bob"),
        ("home.", 24.85, 25.14, "bob"),
        # 25.14 exactly. No silence at all.
        ("All", 25.14, 25.40, "alice"),
        ("right,", 25.40, 25.75, "alice"),
        ("Mr.", 25.75, 26.00, "alice"),
        ("Bob,", 26.00, 26.45, "alice"),
        ("I'll", 26.45, 26.70, "alice"),
        ("come", 26.70, 27.00, "alice"),
        ("see", 27.00, 27.25, "alice"),
        ("you.", 27.25, 27.80, "alice"),
        # ... and the merged turn runs on well past the boundary, as it did in
        # the real response: one utterance, 22.00-32.26, every word labelled B.
        ("Just", 27.80, 28.10, "alice"),
        ("wanted", 28.10, 28.50, "alice"),
        ("to", 28.50, 28.65, "alice"),
        ("give", 28.65, 28.95, "alice"),
        ("you", 28.95, 29.20, "alice"),
        ("an", 29.20, 29.35, "alice"),
        ("update", 29.35, 29.90, "alice"),
        ("on", 29.90, 30.10, "alice"),
        ("Mr.", 30.10, 30.45, "alice"),
        ("Bob.", 30.45, 31.10, "alice"),
    ]),
    # Five words correctly A, then one merged utterance of 23 words all labelled
    # B -- which is what AssemblyAI actually returned, verified four ways.
    provider=["A"] * 5 + ["B"] * 28,
    timeline=_timeline([
        (14.00, 16.25, "D0"),
        (22.00, 25.14, "D1"),
        (25.14, 31.10, "D0"),
    ]),
    note="The reported recording. Every word of the merged region came back B.",
)

# --------------------------------------------------------------------------- #
# 4. A long merged turn -- what the old refiner *could* do, kept as a regression.
# --------------------------------------------------------------------------- #
LONG_MERGE = Fixture(
    name="long merged turn",
    truth=_words(
        [(f"b{i}", -4.0 + i, -3.1 + i, "bob") for i in range(0, 4)]
        + [(f"w{i}", float(i), float(i) + 0.9, "alice") for i in range(0, 12)]
        + [(f"w{i}", float(i), float(i) + 0.9, "bob") for i in range(12, 24)]
    ),
    # A correct B turn earlier in the meeting, then a 24-second region the
    # provider called A throughout. This is the shape the old refiner was built
    # for, and it is credited with handling it below.
    provider=["B"] * 4 + ["A"] * 24,
    timeline=_timeline([(-4.0, 0.0, "D1"), (0.0, 12.0, "D0"), (12.0, 24.0, "D1")]),
)

# --------------------------------------------------------------------------- #
# 5. Rapid A -> B -> A -> B, all short.
# --------------------------------------------------------------------------- #
RAPID = Fixture(
    name="rapid alternation",
    truth=_words([
        ("Yes.", 0.00, 0.45, "alice"),
        ("No.", 0.50, 0.90, "bob"),
        ("Really?", 0.95, 1.55, "alice"),
        ("Really.", 1.60, 2.20, "bob"),
        ("Okay.", 2.25, 2.80, "alice"),
    ]),
    provider=["A", "A", "A", "A", "A"],
    timeline=_timeline([
        (0.00, 0.48, "D0"), (0.48, 0.92, "D1"), (0.92, 1.57, "D0"),
        (1.57, 2.22, "D1"), (2.22, 2.80, "D0"),
    ]),
)

# --------------------------------------------------------------------------- #
# 6. Overlapping speech. The schema holds one speaker per word, so the exclusive
#    timeline is the answer and the limitation is recorded rather than papered
#    over -- see §7 and docs/diarization.md.
# --------------------------------------------------------------------------- #
OVERLAP = Fixture(
    name="overlapping speech",
    truth=_words([
        ("I", 0.00, 0.20, "alice"),
        ("think", 0.20, 0.55, "alice"),
        ("we", 0.55, 0.75, "alice"),
        # Both talk here. The human label says whoever is louder/primary.
        ("should", 0.75, 1.10, "alice"),
        ("wait--", 1.10, 1.60, "alice"),
        ("No,", 1.50, 1.90, "bob"),
        ("now.", 1.90, 2.30, "bob"),
    ]),
    provider=["A", "A", "A", "A", "A", "B", "B"],
    timeline=_timeline([(0.00, 1.55, "D0"), (1.55, 2.30, "D1")]),
    note="Exclusive timeline. Reverie cannot render two speakers on one word.",
)

# --------------------------------------------------------------------------- #
# 7. Noisy / far-field: the diarizer is unsure in the middle and says nothing.
# --------------------------------------------------------------------------- #
NOISY = Fixture(
    name="noisy region",
    truth=_words([
        ("Can", 0.00, 0.30, "alice"),
        ("you", 0.30, 0.55, "alice"),
        ("hear", 0.55, 0.90, "alice"),
        # The middle is unintelligible; no turn covers it.
        ("--", 1.60, 2.40, "bob"),
        ("Yes", 3.00, 3.40, "bob"),
        ("now", 3.40, 3.75, "bob"),
    ]),
    provider=["A", "A", "A", None, "B", "B"],
    timeline=_timeline([(0.00, 0.95, "D0"), (2.95, 3.80, "D1")]),
    note="No confident assignment in the gap. Unresolved is the right answer.",
)

# --------------------------------------------------------------------------- #
# 8. Two similar voices the diarizer merges into one cluster.
# --------------------------------------------------------------------------- #
SIMILAR = Fixture(
    name="similar voices",
    truth=_words([
        ("We", 0.00, 0.25, "alice"),
        ("should", 0.25, 0.60, "alice"),
        ("go.", 0.60, 1.00, "alice"),
        ("I", 1.10, 1.30, "bob"),
        ("agree.", 1.30, 1.80, "bob"),
    ]),
    provider=["A"] * 5,
    # The model cannot tell them apart and returns one cluster. That is a miss,
    # not an invention -- and a miss is the failure we accept.
    timeline=_timeline([(0.00, 1.80, "D0")]),
    note="Must not force a split it cannot hear. Scores as missed boundaries.",
)

# --------------------------------------------------------------------------- #
# 9. Three speakers where the provider found two.
# --------------------------------------------------------------------------- #
THIRD_SPEAKER = Fixture(
    name="third speaker missed by provider",
    truth=_words([
        ("Morning.", 0.00, 0.80, "alice"),
        ("Morning.", 1.00, 1.80, "bob"),
        ("Sorry", 2.00, 2.40, "carol"),
        ("I'm", 2.40, 2.60, "carol"),
        ("late.", 2.60, 3.10, "carol"),
        ("No", 3.30, 3.55, "alice"),
        ("problem.", 3.55, 4.20, "alice"),
    ]),
    # The provider heard two people and folded Carol into B.
    provider=["A", "B", "B", "B", "B", "A", "A"],
    timeline=_timeline([
        (0.00, 0.85, "D0"), (0.95, 1.85, "D1"),
        (1.95, 3.15, "D2"), (3.25, 4.20, "D0"),
    ]),
    note="The diarizer must be allowed to add a speaker the provider missed.",
)

# --------------------------------------------------------------------------- #
# 10. A monologue that must NOT be split.
# --------------------------------------------------------------------------- #
MONOLOGUE = Fixture(
    name="monologue (must not split)",
    truth=_words([(f"w{i}", i * 0.5, i * 0.5 + 0.45, "alice") for i in range(60)]),
    provider=["A"] * 60,
    timeline=_timeline([(0.0, 30.0, "D0")]),
    note="One voice for thirty seconds. Any boundary here is a false positive.",
)

# --------------------------------------------------------------------------- #
# 11. The provider was already right. Must survive untouched.
# --------------------------------------------------------------------------- #
ALREADY_CORRECT = Fixture(
    name="provider already correct",
    truth=_words([
        ("Shall", 0.00, 0.30, "alice"),
        ("we", 0.30, 0.50, "alice"),
        ("start?", 0.50, 1.00, "alice"),
        ("Yes,", 1.20, 1.60, "bob"),
        ("please.", 1.60, 2.10, "bob"),
    ]),
    provider=["A", "A", "A", "B", "B"],
    timeline=_timeline([(0.00, 1.05, "D0"), (1.05, 2.10, "D1")]),
)

ALL: list[Fixture] = [
    INTERJECTION,
    SHORT_HANDOFF,
    NO_SILENCE,
    LONG_MERGE,
    RAPID,
    OVERLAP,
    NOISY,
    SIMILAR,
    THIRD_SPEAKER,
    MONOLOGUE,
    ALREADY_CORRECT,
]
