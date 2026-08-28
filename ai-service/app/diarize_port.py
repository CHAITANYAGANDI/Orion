"""Who was speaking, when — as a timeline over the whole recording.

<h2>Why this is a separate port</h2>

AssemblyAI is the canonical source of *words*: their text, their timings, their
confidence. It is not a reliable source of *who said them*. We have verified
recordings where the provider returns one utterance labelled ``B`` and every
word inside it labelled ``B`` too, across an audible change of voice — so there
is no correct provider label anywhere in the response for Orion to recover.
See docs/diarization.md.

The previous repair (``app/rediarize.py``) worked the other way round: it took
the provider's segmentation as the frame and asked, per suspicious turn, whether
a *known* speaker's voice fitted better. That shape has three limits which are
architectural rather than tuning:

* it needs enough audio on both sides of a candidate boundary to build two
  comparable embeddings, so short turns are structurally out of reach;
* its references come from speakers the provider already found, so a person the
  provider missed entirely cannot be discovered;
* it decides each turn locally, so nothing guarantees the same voice gets the
  same answer twice in one meeting.

A diarizer does not have those limits, because it is not answering per-segment
questions. It reads the whole recording once and returns a partition of time.
This module is the seam it plugs into, so the model behind it can be replaced
without any of the reconciliation logic changing.

<h2>What a port implementation must and must not do</h2>

**Acoustic only.** No transcript text, no LLM, no stored speaker names, no
"short replies belong to the other person". Everything here takes audio bytes
and returns times. Identity — *is this anonymous voice Sarah?* — is a separate
concern that runs afterwards; see app/speaker_identity.py.

**Anonymous and meeting-local.** Labels are cluster ids for this recording
(``D0``, ``D1``). They carry no meaning across meetings and are not display
names.

**Whole-recording.** A timeline is a global clustering, which is what makes the
same voice the same label at minute 1 and minute 40.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Awaitable, Callable, Protocol, Sequence

#: Returns the recording's bytes. A callable rather than the bytes themselves so
#: nothing is downloaded for a meeting that will not be diarized.
AudioLoader = Callable[[], Awaitable[bytes]]


@dataclass(frozen=True)
class SpeakerTurn:
    """One stretch of time attributed to one anonymous cluster.

    Half-open — ``start`` inclusive, ``end`` exclusive — so two adjacent turns
    cannot both claim the instant between them, and a word landing exactly on a
    boundary has one answer rather than two.
    """

    start: float
    end: float
    #: Meeting-local cluster id, e.g. "D0". Not a display name.
    speaker: str

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    def overlap(self, start: float, end: float) -> float:
        """Seconds this turn and ``[start, end)`` have in common."""
        return max(0.0, min(self.end, end) - max(self.start, start))


@dataclass
class Timeline:
    """A whole recording's diarization, plus what the model wants to admit.

    ``turns`` is expected sorted by start and non-overlapping: the reconciler
    below wants an *exclusive* timeline, because Orion stores one speaker per
    word and cannot represent two people saying the same word. Where a model can
    report overlap it is kept in ``overlap_seconds`` for diagnostics rather than
    forced into a schema with nowhere to put it. See §7 of the brief and the
    limitation recorded in docs/diarization.md.
    """

    turns: list[SpeakerTurn] = field(default_factory=list)
    #: Model identifier, for telemetry and for reading a benchmark table later.
    model: str = ""
    #: How much speech the model believes was simultaneous. Diagnostic only.
    overlap_seconds: float = 0.0
    #: Set when the port declined to produce a timeline at all. A reason here
    #: means "use the provider's labels unchanged", never "guess".
    unavailable: str | None = None

    @property
    def ok(self) -> bool:
        return self.unavailable is None and bool(self.turns)

    @property
    def speakers(self) -> list[str]:
        """Cluster ids in order of first appearance."""
        seen: list[str] = []
        for turn in sorted(self.turns, key=lambda t: t.start):
            if turn.speaker not in seen:
                seen.append(turn.speaker)
        return seen

    def speech_seconds(self) -> dict[str, float]:
        """Total attributed time per cluster."""
        totals: dict[str, float] = {}
        for turn in self.turns:
            totals[turn.speaker] = totals.get(turn.speaker, 0.0) + turn.duration
        return totals

    def normalised(self) -> "Timeline":
        """Sorted, with overlaps resolved so every instant has one speaker.

        A model may return overlapping turns. The reconciler needs a partition,
        and resolving that here — once, by a stated rule — is better than every
        caller meeting it differently. The rule: where two turns overlap, the
        one that started earlier keeps the contested span, because its start was
        detected against silence rather than against another voice.

        The amount removed is recorded rather than discarded: it is the honest
        measure of how much of this meeting the schema cannot represent.
        """
        ordered = sorted(self.turns, key=lambda t: (t.start, t.end))
        out: list[SpeakerTurn] = []
        removed = 0.0
        for turn in ordered:
            start, end = turn.start, turn.end
            if out and start < out[-1].end:
                removed += min(out[-1].end, end) - start
                start = out[-1].end
            if end - start <= 0:
                # Wholly inside the previous turn. Nothing survives to place.
                continue
            if out and out[-1].speaker == turn.speaker and start - out[-1].end < 1e-6:
                # Same voice, no gap: one turn, not two adjacent ones.
                out[-1] = SpeakerTurn(out[-1].start, end, turn.speaker)
                continue
            out.append(SpeakerTurn(start, end, turn.speaker))
        return Timeline(
            turns=out,
            model=self.model,
            overlap_seconds=self.overlap_seconds + removed,
            unavailable=self.unavailable,
        )


class DiarizationPort(Protocol):
    """audio → speaker timeline. Nothing else."""

    @property
    def name(self) -> str:
        """Model identifier, recorded on the Timeline and in telemetry."""
        ...

    def available(self) -> bool:
        """Whether this can run at all — weights present, dependencies importable."""
        ...

    async def diarize(self, audio: bytes) -> Timeline:
        """Read the whole recording and return who spoke when.

        Must not raise for ordinary failure: a model that cannot run returns a
        Timeline carrying `unavailable`, and the caller leaves the provider's
        labels alone. An exception here would fail a meeting that has a
        perfectly good transcript.
        """
        ...


def unavailable(reason: str, model: str = "") -> Timeline:
    """The 'leave the provider alone' answer, spelled once."""
    return Timeline(turns=[], model=model, unavailable=reason)


def canonical_map(
    timeline: Timeline,
    *,
    min_speech_seconds: float,
    min_recurrences: int = 2,
) -> tuple[dict[str, str], list[str]]:
    """Cluster ids → meeting-local speaker keys, by first appearance.

    ``D0 D1 D0 D2`` over a meeting becomes ``spk_1 spk_2 spk_1 spk_3`` — the
    same rule ``CanonicalSpeakers`` applies to the provider's letters, for the
    same reason: cluster ids are arbitrary and their order is not the order
    people spoke in.

    <h3>The phantom-speaker guard, and its honest limit</h3>

    A diarizer will occasionally split one person into two clusters over a cough,
    a laugh or a change of microphone distance. Rendered, that is a person who
    was never in the room, and it is worse than a missed speaker because it is
    confident.

    A cluster therefore has to earn its place, by **either** of two signals:

    * **duration** — at least ``min_speech_seconds`` of total attributed speech
      across the whole recording; or
    * **recurrence** — it appears in at least ``min_recurrences`` separate turns,
      however short each one is.

    Either, not both, and the disjunction is the substance. A guard on duration
    alone silences the participant who only ever says "Morning." — who is exactly
    the person §6 is about — while recurrence alone would admit a fan that cycles
    twice. Together they reject the shape an artefact actually has: one isolated
    fragment, heard once, and brief.

    **What this cannot do** is separate a genuine one-word participant from a
    single artefact of the same length; by duration and by recurrence they are
    the same object. Nothing downstream of the diarizer can. The real defence
    there is the clustering quality of the model itself, and the floor below is
    only a guard against sub-half-second debris — set it high enough to stop a
    determined phantom and it starts deleting people.

    Clusters that fail are returned as ``rejected`` and their audio becomes
    unresolved rather than being handed to whoever is nearest.
    """
    totals = timeline.speech_seconds()
    counts: dict[str, int] = {}
    for turn in timeline.turns:
        counts[turn.speaker] = counts.get(turn.speaker, 0) + 1

    mapping: dict[str, str] = {}
    rejected: list[str] = []
    for cluster in timeline.speakers:
        long_enough = totals.get(cluster, 0.0) >= min_speech_seconds
        came_back = counts.get(cluster, 0) >= min_recurrences
        if not (long_enough or came_back):
            rejected.append(cluster)
            continue
        mapping[cluster] = f"spk_{len(mapping) + 1}"
    return mapping, rejected


def turns_at(timeline: Sequence[SpeakerTurn], start: float, end: float) -> list[SpeakerTurn]:
    """Every turn sharing any time with ``[start, end)``."""
    return [t for t in timeline if t.overlap(start, end) > 0]
