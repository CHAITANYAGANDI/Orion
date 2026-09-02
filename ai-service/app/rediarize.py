"""Checking the provider's turn boundaries against the audio itself.

## The bug this exists for

A real recording, reported by a user:

```
Speaker 2 (00:22)  "Okay, you have a good day anyway. I'm going home.
                    All right, Mr. Bob, I'll come see you when I get off.
                    Just want to give y'all a little update on Mr. Bob..."
```

Two people. The first sentence is one of them saying goodbye; everything after
it is the other one, starting a new thought. The transcript put all of it on one
speaker.

**This is not Reverie losing information.** The audio was re-submitted to
AssemblyAI four ways — as sent today, with `speakers_expected: 2`, with
`speaker_options{min: 2, max: 2}`, and on `universal-2` — and every run returned
the same merged utterance with **every word labelled `B`**, in both the
`utterances` array and the top-level `words` array. There was nothing in the
response to recover. Speaker constraints did not help because the provider had
already found exactly two speakers; it simply put the boundary in the wrong
place.

So the only remaining evidence is the sound, and since `V53` Reverie has a
speaker embedding model of its own. This module uses it to ask one question
about each suspiciously long turn: **does the audio actually stay with one
person the whole way through?**

## Why not the obvious alternatives

**A pause.** There is no pause at the true boundary — the provider's own word
timings put "home." ending at 25.14 and "All" starting at 25.14, a gap of
exactly zero. Silence would have missed this. `docs/diarization.md` §6 rules out
pause length as a speaker-change signal anyway, and this recording is the reason
that rule is right rather than merely cautious.

**The text.** "I'm going home." followed by "All right, Mr. Bob" reads like a
handover to a person and like a continuation to a rule. Every text heuristic
that gets this right invents boundaries somewhere else, confidently.

## What it is allowed to do, and what it is not

It may **move words between speakers who are already in the meeting**. It may
not create one. There is no path here that invents a Speaker 3, because the only
labels it can assign are the ones the provider already used — so canonical
numbering, colours, talk-time and voice profiles are all untouched by a repair.

Every rule below is a way of declining. A false split is a new failure mode that
did not exist before this file, and it is worse than the bug it fixes: a missed
boundary leaves two sentences under one name, which a reader can see and
correct, while an invented boundary puts words in somebody's mouth in a
transcript that now looks *more* carefully attributed than it is.

## Cost

Off unless the embedder is installed, and off for any meeting with nothing
suspicious in it. When it does run, the audio is fetched once and decoded once,
each candidate boundary costs two embeddings, and the search is coarse-to-fine
so a sixty-second turn costs no more than a ten-second one. The whole thing is
wrapped so that any failure leaves the provider's own segmentation exactly as it
was.

## Why this runs in a thread

The work above is CPU-bound and synchronous, and on a real meeting it runs for
minutes — one observed refinement took eight minutes and forty-one seconds.

It used to run on the event loop, and that was not a latency nicety. The
ai-service answers chat on the same loop and runs the Kafka consumer on it as an
asyncio task, so a refinement in progress stopped both. Every question queued
behind it. Worse, aiokafka's heartbeat is also a coroutine on that loop: it was
never scheduled, the broker declared the consumer dead after ten seconds, the
group rebalanced, and the hand-committed offset stayed where it was — so the
meeting was redelivered and transcribed again, at full price, its status walking
backwards from EXTRACTING to TRANSCRIBING in front of the person waiting for it.
One upload was transcribed three times.

No Kafka timeout can fix that, because the problem is a coroutine that is never
given the loop. `_refine` hands the whole synchronous body to
`asyncio.to_thread` instead. It releases the GIL where it matters — the model's
forward pass is native code and the decode is a subprocess — so the loop stays
free to heartbeat and to answer while a meeting is being examined.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Sequence

from app.diarization import join_words
from app.schemas import Segment, Word
from app.voiceprints import centroid, cosine

logger = logging.getLogger("ai-service.rediarize")

#: Returns the recording's bytes. Called at most once per meeting, and only when
#: there is a turn worth examining — so a meeting the provider got right costs
#: nothing at all.
AudioLoader = Callable[[], Awaitable[bytes]]

#: Turns a stretch of the recording into a voice vector, or None where there is
#: not enough of it to be worth a vector. Everything in this module reasons in
#: terms of this one function: decoding, span selection and the model itself are
#: on the other side of it.
Sampler = Callable[[float, float], "list[float] | None"]

#: Builds a Sampler from the recording's bytes. Injectable so the rules below can
#: be tested against constructed voices without a gigabyte of model, and so a
#: future embedder can be swapped in without touching any of the logic.
SamplerFactory = Callable[[bytes], Sampler]


@dataclass(frozen=True)
class Limits:
    """Every number here is a way of doing less.

    Defaults are calibrated against the reported recording and against a control
    turn in the same file that the provider got right; see
    `tests/test_rediarize.py` and `docs/diarization.md` §10.
    """

    #: A turn at least this long is examined. Shorter ones are left alone: the
    #: reward is small, the audio available on each side of any split is thin,
    #: and thin audio is exactly where the embedder is least reliable.
    examine_from_seconds: float = 6.0

    #: A turn at most this long is trusted *whole* as evidence of a voice: it
    #: is too short to be concealing anybody. Longer turns are not excluded any
    #: more — they are sampled from their interiors, see the three window
    #: settings below — because a meeting made entirely of long turns used to
    #: yield no evidence at all and refinement declined on the one recording it
    #: was written for.
    reference_to_seconds: float = 6.0

    #: How much audio one reference window holds. Long enough for the embedder
    #: to have something to work with, short enough that several fit inside an
    #: ordinary turn and disagree with each other when the turn hides a second
    #: speaker.
    reference_window_seconds: float = 3.0
    #: Skipped at each end of a long turn before windows are taken. A boundary
    #: the provider got wrong is at the *edges* of what it labelled, so the
    #: interior is the part least likely to belong to somebody else.
    reference_window_inset_seconds: float = 1.0
    #: Windows taken from any single turn, so one long monologue cannot supply
    #: a speaker's entire reference.
    reference_windows_per_turn: int = 3
    #: Regions -- turns -- sampled per speaker across the whole meeting. Each
    #: contributes exactly one vote however many windows fit inside it, so a
    #: long turn cannot outvote the regions it should be corroborated by.
    #: Bounds the embedding cost too.
    reference_regions_max: int = 6

    #: How much reference speech to gather per speaker, shortest turns first.
    #: Shortest first is the opposite of what `choose_spans` does for a profile,
    #: and deliberately: there the goal is the best picture of a voice, here it
    #: is the *safest* audio, and a two-second turn cannot conceal a ten-second
    #: one.
    reference_budget_seconds: float = 12.0
    #: Below this much reference speech a speaker has no usable reference, and
    #: no split may assign anything to them.
    reference_floor_seconds: float = 3.0

    #: Each side of a proposed split needs this much audio to be judged on.
    min_side_seconds: float = 2.0
    #: Candidate boundaries per coarse pass, then a fine pass around the winner.
    #: Bounds the cost of a long turn to that of a short one.
    coarse_candidates: int = 12
    fine_step_seconds: float = 0.25
    #: One turn may hide more than one missed boundary, but not many.
    max_splits_per_segment: int = 3
    #: A whole-meeting budget, so a pathological transcript cannot stall a job.
    max_segments_examined: int = 40

    #: How alike two provider labels must be before they are treated as one
    #: voice. Deliberately far above every other similarity number here: this
    #: one merges two people into one if it is wrong, and unlike a bad split
    #: there is nothing left in the transcript to notice it by.
    #:
    #: High is affordable because the comparison is unusually easy. Both
    #: references come from the same recording, the same microphone and the same
    #: room, so two references of one person are far closer here than the same
    #: two would be across meetings -- which is the case `speaker_match_threshold`
    #: is set for, and why that number is much lower and not reused.
    merge_similarity: float = 0.85
    #: The band below it where the answer is "possibly". A single pair landing
    #: in it abandons merging for the whole meeting rather than merging the
    #: pairs above it: an ambiguous pair means the references are not clean
    #: enough to be drawing conclusions from anywhere in this recording.
    merge_margin: float = 0.10

    # --- micro-turn islands (segment-level correction) ---------------------- #
    #: A turn this short, surrounded by other people, is a candidate for having
    #: been mislabelled outright. Not a rule about interjections -- plenty are
    #: real -- only about which turns are worth the cost of asking.
    island_max_seconds: float = 2.0
    #: The stretch embedded to judge one. Just above the embedder's own
    #: `MIN_SPAN_SECONDS` of 0.8, below which it refuses to answer at all: a
    #: one-word turn is mostly the tail of somebody else's word, and the model
    #: says so rather than guessing. Sitting just above the floor keeps the
    #: island the largest possible share of what is being listened to.
    island_probe_seconds: float = 1.0
    #: How far below its neighbours' own score the probe may fall and still count
    #: as "no other voice in here". The probe necessarily contains a little of
    #: the neighbouring audio, so it is scored against a same-length window of
    #: *pure* neighbour rather than against an absolute number -- otherwise the
    #: padding would make every island match its neighbour by construction.
    #:
    #: Small, because the comparison is like for like: two windows of one person
    #: score within a hair of each other, so anything more than a hair is a
    #: second voice. Measured against constructed voices, an island that is even
    #: 45% somebody else costs the neighbour's score more than this.
    island_tolerance: float = 0.02

    #: How much further apart two halves of one label's audio must be than each
    #: half is from itself, before they are called two people. The mirror of
    #: `merge_margin` and the same reasoning: a voice varies across a meeting,
    #: and varying is not separating.
    split_margin: float = 0.10

    #: Whether a provider label found to cover two voices is actually split.
    #:
    #: **Off.** Built for one production case -- a substantial turn nine minutes
    #: in belonging to a different person -- and after deployment that case was
    #: still wrong while other regions had regressed. Real cost, unproven
    #: benefit, so it stays disabled until a trace from the real recording shows
    #: what its raw and acoustic shape actually is. The analysis still runs and
    #: still reports what it *would* have done, so the evidence needed to
    #: re-enable it can be gathered without the deployment being the experiment.
    split_labels_enabled: bool = False

    #: The winning speaker on each side must beat the runner-up by this much.
    assign_margin: float = 0.10
    #: And the two sides must be this dissimilar to each other. The check that
    #: matters most: two halves of one person's turn score high against the same
    #: reference *and* high against each other, and only the second is
    #: diagnostic when a reference is mediocre.
    max_side_similarity: float = 0.35
    #: If the meeting's own speakers are not further apart than this, nothing is
    #: attempted anywhere in it. The model cannot tell these voices apart, so
    #: every split would be a coin toss dressed as a correction.
    max_reference_similarity: float = 0.55


@dataclass
class Report:
    """What happened, for the log line and the tests.

    Counts and one reason string, and deliberately nothing else. No speaker
    names, no turn text, no timings, no vectors and no similarity matrix — this
    object is what gets logged on a deployment holding other people's meetings,
    so what it cannot carry it cannot leak.
    """

    examined: int = 0
    split: int = 0
    skipped_reason: str | None = None

    #: Speakers with enough short, trustworthy audio to say what they sound
    #: like. Two is the minimum for any split to be judged, so this is the
    #: number that distinguishes "declined for want of evidence" from "looked
    #: and found nothing wrong".
    references: int = 0

    #: Distinct attributed speakers the provider reported. Set on every path,
    #: including the ones that return before any audio is decoded, because it is
    #: the one figure that says whether the provider had already collapsed the
    #: meeting before refinement was ever asked.
    provider_speakers: int = 0

    #: Provider labels folded into another because the audio said they were the
    #: same voice. Non-zero means the provider over-diarized -- five labels for
    #: two people -- which is the opposite failure from the merged turn this
    #: module was built for, and needs the same evidence to correct.
    merged: int = 0

    #: Distinct voices left after that folding: what the transcript will show.
    canonical_speakers: int = 0

    #: Very short turns sitting between other speakers, and what became of them.
    #: A different correction from `merged` and deliberately counted apart: that
    #: one decides two labels are one person everywhere, this one decides a
    #: single turn was filed under the wrong person while its label stays a real
    #: person elsewhere in the same meeting.
    islands_examined: int = 0
    islands_corrected: int = 0
    islands_ambiguous: int = 0

    #: Provider labels found to be covering two people, and the substantial
    #: turns moved as a result. The opposite correction from `merged`, counted
    #: apart so a log line says which direction the provider was wrong in.
    labels_split: int = 0
    substantial_reassigned: int = 0

    #: What the disabled within-label split *would* have done, and how many
    #: labels came out acoustically self-contradictory. Observation only.
    labels_would_split: int = 0
    heterogeneous_labels: int = 0

    @property
    def changed(self) -> bool:
        # Merging and island corrections both rename turns, so they change the
        # transcript as surely as a split does and the flat text has to be
        # rebuilt for any of the three.
        return (self.split > 0 or self.merged > 0
                or self.islands_corrected > 0 or self.substantial_reassigned > 0)

    def as_log_fields(self) -> str:
        """The diagnostic, as one line of `key=value` pairs.

        Assembled here rather than at the call site so there is one definition
        of what this component is allowed to say about a meeting.
        """
        return (
            f"reason={self.skipped_reason} "
            f"examinedTurns={self.examined} "
            f"usableReferences={self.references} "
            f"providerSpeakers={self.provider_speakers} "
            f"mergedLabels={self.merged} "
            f"canonicalSpeakers={self.canonical_speakers} "
            f"splitTurns={self.split} "
            f"microTurnsExamined={self.islands_examined} "
            f"microTurnsCorrected={self.islands_corrected} "
            f"microTurnsAmbiguous={self.islands_ambiguous} "
            f"rawLabelsSplit={self.labels_split} "
            f"substantialTurnsReassigned={self.substantial_reassigned} "
            f"rawLabelsWouldSplit={self.labels_would_split} "
            f"heterogeneousLabels={self.heterogeneous_labels}"
        )


@dataclass
class _Run:
    """Consecutive turns the transcript currently gives to one speaker."""

    speaker: str | None
    segments: list[Segment]

    @property
    def start(self) -> float:
        return float(self.segments[0].start)

    @property
    def end(self) -> float:
        return float(self.segments[-1].end)

    @property
    def seconds(self) -> float:
        return sum(_duration(s) for s in self.segments)


def _speaker_runs(segments: Sequence[Segment]) -> list[_Run]:
    """Group consecutive turns by who currently owns them.

    Runs rather than segments, so that two short turns in a row under one wrong
    label are examined once as a region. Looked at individually they would be
    two separate islands, each with the other as a neighbour, and the answer for
    one would depend on the order the other was decided in.
    """
    runs: list[_Run] = []
    for seg in segments:
        speaker = seg.speaker if seg.speaker_status == "attributed" else None
        if runs and runs[-1].speaker == speaker:
            runs[-1].segments.append(seg)
        else:
            runs.append(_Run(speaker=speaker, segments=[seg]))
    return runs


def _clear_best(vector: list[float], references: dict[str, list[float]],
                margin: float) -> str | None:
    """The voice this stretch belongs to, or None if it is not clearly one.

    The margin is what makes a wrong answer unlikely rather than merely
    unlucky: a stretch that scores 0.71 against one person and 0.69 against
    another has told us nothing, and saying so is the whole point.
    """
    ranked = sorted(
        ((cosine(vector, ref), name) for name, ref in references.items()),
        reverse=True,
    )
    if not ranked:
        return None
    if len(ranked) > 1 and ranked[0][0] - ranked[1][0] < margin:
        return None
    return ranked[0][1]


#: Marks the second half of a label being split, until `_renumber` gives every
#: speaker a real number again. A control character so it cannot collide with a
#: label the provider or a user could produce.
_HALF = chr(0) + "b"


def _other_half(name: str) -> str:
    return f"{name}{_HALF}"


def _is_half(name: str) -> bool:
    return name.endswith(_HALF)


def _span_seconds(windows) -> float:
    return sum(hi - lo for (lo, hi), _ in windows)


def _cross_similarity(first, second, *, worst: bool = False) -> float:
    """How alike two sets of windows are: the mean, or the weakest pair."""
    pairs = [cosine(a, b) for _, a in first for _, b in second]
    if not pairs:
        return 0.0
    return min(pairs) if worst else sum(pairs) / len(pairs)


def _bisect(windows):
    """Split one speaker's windows into the two most separated groups, or None.

    Seeded from the least similar pair rather than at random, so the answer does
    not depend on window order, and every other window joins whichever seed it
    is closer to. Deliberately the crudest clustering that can answer the
    question -- the decision about whether the two groups are *really* two
    people is made by the caller against the groups' own spread, and a cleverer
    partition would not change that judgement, only make it harder to read.
    """
    if len(windows) < 2:
        # Nothing to divide. Two regions is enough to ask the question -- each
        # side is then a whole turn, not a fragment of one -- and the caller
        # still requires both sides to hold real speech before believing it.
        return None
    worst, seeds = 2.0, None
    for i, (_, a) in enumerate(windows):
        for j, (_, b) in enumerate(windows[i + 1:], start=i + 1):
            score = cosine(a, b)
            if score < worst:
                worst, seeds = score, (i, j)
    if seeds is None:
        return None
    left_seed, right_seed = windows[seeds[0]][1], windows[seeds[1]][1]
    first, second = [], []
    for window in windows:
        target = first if cosine(window[1], left_seed) >= cosine(window[1], right_seed) else second
        target.append(window)
    if not first or not second:
        return None
    return first, second


@dataclass
class Reference:
    """What one canonical speaker sounds like, and the evidence behind it.

    The windows are carried rather than discarded because the two corrections
    that came after this class both need them: merging has to check that every
    window of one label agrees with every window of the other, not merely that
    their averages do, and splitting has to look for two clusters *inside* one
    label. A centroid alone hides both.
    """

    vector: list[float]
    #: `((start, end), embedding)` -- one entry per *region*, not per window.
    windows: list[tuple[tuple[float, float], list[float]]]
    #: True when this label's own regions fall into two separated voices: the
    #: provider reused one label for two people, or filed somebody else's turn
    #: under it. Detection only; nothing is split on it.
    heterogeneous: bool = False
    #: Every window embedded for this speaker, before regions were collapsed to
    #: one vote each. Kept because a speaker with a single turn has no spread
    #: *between* regions and would otherwise have no measurable consistency at
    #: all -- which would quietly make them unmergeable, since the merge is
    #: calibrated against exactly that number.
    samples: list[list[float]] = field(default_factory=list)

    @property
    def vectors(self) -> list[list[float]]:
        return [vec for _, vec in self.windows]

    @property
    def consistency(self) -> float | None:
        """How alike this speaker's own evidence is, or None with too little.

        Between regions where there are two or more, because agreement across
        separate turns is the stronger claim. A speaker heard once falls back to
        the windows inside that one turn -- weaker evidence, honestly labelled
        as the only evidence there is, and better than refusing to measure.
        """
        return _consistency(self.vectors) or _consistency(self.samples)


def _consistency(vectors: list[list[float]]) -> float | None:
    """How alike one speaker's own windows are, or None if there is only one.

    This is the number that makes merging safe without a magic threshold. Two
    labels scoring 0.99 against each other means nothing on its own: it is
    "obviously the same person" if either label's own windows only manage 0.95
    among themselves, and "two people this model cannot separate" if they manage
    0.999. The same figure, opposite conclusions, and the difference is a
    property of the recording rather than of any constant.

    A speaker with one window has no spread to measure, and no merge involving
    them can be justified this way.
    """
    if len(vectors) < 2:
        return None
    pairs = [
        cosine(a, b)
        for i, a in enumerate(vectors)
        for b in vectors[i + 1:]
    ]
    return sum(pairs) / len(pairs)


def _robust_centroid(vectors: list[list[float]]) -> list[float]:
    """The average of the windows, after discarding the least typical one.

    A reference is only as good as the audio behind it, and one window can be
    ruined by a cough, a door, or the speaker the provider missed. Averaging
    everything lets that one window pull the reference toward a voice its owner
    does not have; the effect is small, and small is enough, because every later
    decision is a margin between two similarities.

    Dropping the *single* least central vector is deliberately the weakest
    version of this. A median or a medoid would throw away more and would also
    discard the natural variation that makes a reference describe a person
    rather than a moment. With fewer than three windows nothing is dropped —
    there is no majority to be typical of, and two windows disagreeing is not
    evidence about which one is wrong.
    """
    if len(vectors) < 3:
        return centroid(vectors)
    scores = [
        sum(cosine(vec, other) for j, other in enumerate(vectors) if j != i)
        for i, vec in enumerate(vectors)
    ]
    worst = scores.index(min(scores))
    return centroid([v for i, v in enumerate(vectors) if i != worst])


def _duration(seg: Segment) -> float:
    return max(0.0, float(seg.end) - float(seg.start))


def _identity_of(seg: Segment) -> tuple[str, str | None, str]:
    return (seg.speaker, seg.speaker_key, seg.speaker_status)


class SpeakerRefiner:
    """Second-guesses the provider's turn boundaries, conservatively.

    Constructed once and reused. The embedder is loaded lazily, so an
    installation without torch never pays for this and never runs it — the
    provider's segmentation is simply returned untouched, which is exactly the
    behaviour that existed before this module.
    """

    def __init__(self, *, limits: Limits | None = None, embedder=None,
                 sampler_for: SamplerFactory | None = None) -> None:
        self._limits = limits or Limits()
        self._embedder = embedder
        self._checked = embedder is not None
        self._sampler_for = sampler_for

    # --- availability ------------------------------------------------------- #
    @property
    def embedder(self):
        if not self._checked:
            self._checked = True
            try:
                from app.providers.ecapa_embedder import EcapaEmbedder

                if EcapaEmbedder.installed():
                    self._embedder = EcapaEmbedder()
            except Exception:  # noqa: BLE001 - absent is the same as broken here
                self._embedder = None
        return self._embedder

    @property
    def available(self) -> bool:
        return self._sampler_for is not None or self.embedder is not None

    def _default_sampler(self, audio: bytes) -> Sampler:
        """Decode once, then embed whatever stretch is asked for.

        The PCM is held for the length of one meeting's refinement and dropped
        with the closure. Nothing is written to disk, and no waveform is logged.
        """
        from app.providers.ecapa_embedder import decode_to_pcm, take_spans

        pcm = decode_to_pcm(audio)
        cache: dict[tuple[float, float], list[float] | None] = {}

        def sample(start: float, end: float) -> list[float] | None:
            key = (round(start, 2), round(end, 2))
            if key not in cache:
                try:
                    cache[key] = self.embedder.embed(take_spans(pcm, [(start, end)]))
                except Exception:  # noqa: BLE001 - too short, or a bad stretch
                    # A stretch that cannot be embedded is one this module
                    # declines to judge, which is the same outcome as judging it
                    # and finding nothing.
                    cache[key] = None
            return cache[key]

        return sample

    # --- the entry point ---------------------------------------------------- #
    async def refine(
        self,
        segments: list[Segment],
        audio_loader: AudioLoader | None,
    ) -> tuple[list[Segment], Report]:
        """Return the segments, repaired where the audio disagrees with them.

        Never raises. Every failure path — no model, no audio, undecodable
        audio, an embedder that throws — returns the input unchanged, because
        the alternative is failing a whole meeting over a refinement that was
        only ever going to improve it.
        """
        report = Report()
        # Counted first, so every early return below still carries it. A
        # meeting the provider had already collapsed to one voice and a meeting
        # refinement simply had nothing to do on are different problems, and
        # without this figure they produce the same log line.
        report.provider_speakers = len({
            seg.speaker for seg in segments
            if seg.speaker and seg.speaker_status == "attributed"
        })
        if not segments or audio_loader is None:
            report.skipped_reason = "nothing to examine"
            return segments, report
        if not self.available:
            report.skipped_reason = "embedder not installed"
            return segments, report

        suspects = [i for i, s in enumerate(segments)
                    if _duration(s) >= self._limits.examine_from_seconds and len(s.words) >= 4]
        if not suspects:
            report.skipped_reason = "no turn long enough to hide another"
            return segments, report

        try:
            return await self._refine(segments, audio_loader, report)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Speaker refinement failed (%s); keeping the provider's segmentation.",
                type(exc).__name__,
            )
            report.skipped_reason = f"failed: {type(exc).__name__}"
            return segments, report

    async def _refine(
        self, segments: list[Segment], audio_loader: AudioLoader, report: Report
    ) -> tuple[list[Segment], Report]:
        audio = await audio_loader()
        if not audio:
            report.skipped_reason = "no audio available"
            return segments, report

        # Off the event loop. Everything past this point is synchronous and
        # runs for minutes on a real meeting; see "Why this runs in a thread"
        # in the module docstring for what it cost when it did not.
        return await asyncio.to_thread(self._refine_blocking, segments, audio, report)

    def _refine_blocking(
        self, segments: list[Segment], audio: bytes, report: Report
    ) -> tuple[list[Segment], Report]:
        """The refinement itself. Runs in a worker thread; see `_refine`.

        Touches nothing shared but the embedder, which is loaded once and only
        read from here — one meeting is refined at a time, because the pipeline
        awaits this before moving on.
        """
        embed = (self._sampler_for or self._default_sampler)(audio)
        del audio

        refs = self._references(segments, embed)
        report.references = len(refs)
        report.heterogeneous_labels = sum(1 for r in refs.values() if r.heterogeneous)
        report.canonical_speakers = len(refs)
        if len(refs) < 2:
            report.skipped_reason = "fewer than two speakers with usable reference audio"
            return segments, report

        # Over-diarization, before under-diarization. The provider can be wrong
        # in both directions in one recording -- five labels for two people, and
        # a turn holding two of them -- and the merge has to happen first
        # because every check below compares references to each other. Left
        # unmerged, one person's two labels are a pair of references that are
        # nearly identical, and the "too alike to judge" gate reads that as a
        # model that cannot separate the voices in this meeting and declines
        # everything. That is exactly what the production recording did.
        segments, refs, merged = self._merge_labels(segments, refs)
        report.merged = merged
        report.canonical_speakers = len(refs)
        if len(refs) < 2:
            # One voice, recorded under several labels. Nothing left to split
            # against, and the merge is still worth keeping.
            report.skipped_reason = "one voice once the provider's labels were merged"
            return segments, report

        # Under-diarization at the label level: one provider label covering two
        # people. The mirror of the merge above and it has to run after it, so
        # that what is examined for heterogeneity is a canonical speaker rather
        # than whichever fragment of one the provider happened to label.
        segments, refs = self._split_labels(segments, refs, embed, report)
        report.canonical_speakers = len(refs)

        references = {name: ref.vector for name, ref in refs.items()}
        worst = max(
            cosine(a, b)
            for i, a in enumerate(references.values())
            for b in list(references.values())[i + 1:]
        )
        if worst > self._limits.max_reference_similarity:
            # Not a failure. The honest reading is that this model cannot
            # separate these voices in this recording, and a split made on that
            # basis would be a guess with a confident face.
            # No log line here. This was the one decline that said anything,
            # and it now says it in the same place as the other four -- the
            # caller emits exactly one line covering all of them, so a reader
            # greps for one string rather than knowing which branch fired.
            #
            # The cosine is kept: it is a scalar derived from two references,
            # not a template, and it is the only number that distinguishes "this
            # model cannot separate these voices" from a threshold being wrong.
            report.skipped_reason = f"speakers too alike to judge (cos={worst:.2f})"
            return segments, report

        # Layer 2: a single turn filed under the wrong speaker, while that
        # speaker goes on being real elsewhere. Before the split search, because
        # a mislabelled micro-turn sitting inside what is really one person's
        # speech is also a spurious boundary in the middle of the region the
        # split search is about to reason over.
        self._correct_islands(segments, references, embed, report)

        identities = {
            seg.speaker: _identity_of(seg)
            for seg in segments
            if seg.speaker and seg.speaker_status == "attributed"
        }

        out: list[Segment] = []
        for seg in segments:
            if report.examined >= self._limits.max_segments_examined:
                out.append(seg)
                continue
            if _duration(seg) < self._limits.examine_from_seconds or len(seg.words) < 4:
                out.append(seg)
                continue
            report.examined += 1
            out.extend(self._resolve(seg, references, identities, embed, report,
                                     depth=self._limits.max_splits_per_segment))

        # No log line here either. The caller emits exactly one, covering both
        # outcomes and both corrections, so a reader greps one string rather
        # than knowing which of this module's branches fired.
        return out, report

    # --- references --------------------------------------------------------- #
    def _references(self, segments: Sequence[Segment], embed):
        """What each speaker sounds like, from short turns *and* window interiors.

        <h2>The bug this replaced</h2>

        This used to take whole turns and only whole turns, and only ones no
        longer than `reference_to_seconds`. The reasoning was sound — a short
        turn cannot be concealing a second speaker, so it is the safest evidence
        of what one person sounds like — and it had a hole big enough to lose a
        meeting through: **a recording made entirely of long turns has no safe
        evidence at all.**

        One did, in production:

            AssemblyAI returned 7 segment(s) across 5 speaker(s)
            reason=fewer than two speakers with usable reference audio
            usableReferences=0  providerSpeakers=5

        Seven turns over two and a half minutes averages twenty seconds each.
        Every one of them was longer than the cutoff, so every one was excluded,
        `by_speaker` came out empty, and refinement returned before examining a
        single turn — on exactly the recording it was written for.

        <h2>What replaced it</h2>

        The old rule confused two different things: *"is this stretch safe to
        trust?"* and *"is this whole turn short?"* Only the first matters, and a
        twenty-second turn contains a great deal of stretch that is perfectly
        safe. So evidence is now gathered per *window* rather than per turn:

            turn A, 20s  ->  |--inset--|  win  |  win  |  win  |--inset--|

        The insets are the point. A speaker change the provider missed is most
        likely at the edges of what it labelled — that is where its boundary
        went wrong — so the interior is the part least likely to be somebody
        else. Several independent windows beat one long embedding for the same
        reason a photograph of a face beats a long exposure of one.

        A turn short enough to trust whole still is, exactly as before, so every
        meeting the old rule handled is handled identically.

        Nothing here reads a word of transcript. Windows are chosen by the
        clock, and the only thing consulted is the sound.
        """
        floor = self._limits.reference_floor_seconds

        # One region per turn, and every turn contributes -- a short one whole,
        # a long one through its interior windows.
        #
        # This replaced a rule that took short turns *exclusively* whenever they
        # reached the floor, and only fell back to long ones when they did not.
        # The reasoning was that a short turn cannot be concealing a second
        # speaker, which is true and was not the whole question. In a real
        # meeting one provider label held 157 seconds of audio across seven
        # turns; eleven of those seconds were short, so 146 were never looked
        # at -- and four of the eleven were a turn the provider had attributed
        # to the wrong person. A third of that speaker's entire reference was
        # somebody else's voice, with a minute and a half of their own sitting
        # unread.
        #
        # Being short makes a turn *trustworthy*, not *sufficient*. Both now
        # count.
        regions: dict[str, list[tuple[float, float, list[tuple[float, float]]]]] = {}
        for seg in segments:
            if seg.speaker_status != "attributed" or not seg.speaker:
                continue
            spans = self._reference_windows(seg)
            if spans:
                regions.setdefault(seg.speaker, []).append(
                    (float(seg.start), float(seg.end), spans))

        built: dict[str, Reference] = {}
        for speaker, found in regions.items():
            windows: list[tuple[tuple[float, float], list[float]]] = []
            samples: list[list[float]] = []
            sampled = 0.0
            for begin, finish, spans in self._spread(found):
                vectors = [v for v in (embed(lo, hi) for lo, hi in spans) if v]
                if not vectors:
                    continue
                # One vote per region, however many windows fit inside it. A
                # sixty-second turn is better evidence than a four-second one
                # and is not fifteen *independent* observations of it; letting
                # it contribute fifteen vectors would outvote every region it
                # ought to be corroborated by, and would make the robust
                # aggregate below a formality.
                windows.append(((begin, finish), _robust_centroid(vectors)))
                samples.extend(vectors)
                sampled += sum(hi - lo for lo, hi in spans)
            if not windows or sampled < floor:
                continue
            built[speaker] = Reference(
                vector=_robust_centroid([vec for _, vec in windows]),
                windows=windows,
                samples=samples,
                heterogeneous=self._is_heterogeneous(windows),
            )
        return built

    def _is_heterogeneous(self, windows) -> bool:
        """Whether one label's regions fall into two clearly separated voices.

        The same test `_split_labels` applies, computed once here so the merge
        can read it too. **Detection only** -- nothing is split on it, because
        that mechanism is disabled pending production evidence.

        What it is used for is making the merge refuse. A label whose own
        regions disagree has a reference describing an average of two people,
        and an average of two people can resemble a third convincingly. Merging
        on that is how two real humans end up under one name.
        """
        groups = _bisect(windows)
        if groups is None:
            return False
        first, second = groups
        within = min(_consistency([v for _, v in first]) or 1.0,
                     _consistency([v for _, v in second]) or 1.0)
        if _cross_similarity(first, second) >= within - self._limits.split_margin:
            return False
        return min(_span_seconds(first), _span_seconds(second)) >=             self._limits.reference_floor_seconds

    # --- over-diarization --------------------------------------------------- #
    def _merge_labels(self, segments: list[Segment], references: dict[str, "Reference"]):
        """Fold provider labels that are one voice into one canonical speaker.

        The provider can be wrong in both directions. This module was written
        for the merged turn — two people under one label — and production
        produced the mirror image: **seven turns, five labels, and nowhere near
        five people in the room.**

        Only the sound is consulted. Not how many labels there are, not how
        little any of them said, not the transcript. "Too many speakers" is not
        evidence about any particular pair, and talk-time is not evidence of
        identity: a person who says one word is a person.

        <h2>Why an ambiguous pair stops everything</h2>

        A pair scoring inside `merge_margin` of the bar abandons merging for the
        entire meeting rather than merging only the pairs above it. It is
        tempting to keep the confident ones, and it is wrong: similarity here is
        one number from one model over one recording, and a pair that lands in
        the maybe-band is evidence that these references are not clean enough to
        be concluding anything from — including about the pairs that scored well.

        The asymmetry is the usual one. A refused merge leaves two labels on one
        person, which a reader sees and can fix with one rename. A wrong merge
        puts two people under one name and destroys the distinction, and nothing
        left in the transcript records that it happened.

        `speaker_raw` is never touched. A turn folded from `C` into
        `Speaker 1` still says the provider called it `C`, which is what keeps
        this reversible and a complaint traceable.
        """
        limits = self._limits
        names = list(references)
        same: list[tuple[str, str]] = []
        for i, a in enumerate(names):
            for b in names[i + 1:]:
                score = cosine(references[a].vector, references[b].vector)
                if score < limits.merge_similarity - limits.merge_margin:
                    continue                      # comfortably two people
                if score < limits.merge_similarity:
                    # Possibly the same person. "Possibly" is not a reason to
                    # merge anybody, here or anywhere else in this meeting.
                    return segments, references, 0
                if not self._one_voice(a, b, score, references, names):
                    # Alike, but no more alike than either label is to itself.
                    # Two people this model cannot separate look exactly like
                    # one person under two labels, and only this tells them
                    # apart. Refusing is the same admission the "too alike to
                    # judge" gate makes further down.
                    return segments, references, 0
                same.append((a, b))
        if not same:
            return segments, references, 0

        group = {name: name for name in names}

        def root(name: str) -> str:
            while group[name] != name:
                group[name] = group[group[name]]
                name = group[name]
            return name

        for a, b in same:
            ra, rb = root(a), root(b)
            if ra != rb:
                group[rb] = ra

        # Canonical numbering by first appearance, exactly as the provider's own
        # labels were numbered in `parse_response` -- so a merged transcript
        # counts its speakers the same way an unmerged one does.
        order: dict[str, int] = {}
        for seg in segments:
            if seg.speaker_status != "attributed" or seg.speaker not in group:
                continue
            key = root(seg.speaker)
            if key not in order:
                order[key] = len(order) + 1

        renamed = {
            name: (f"Speaker {order[root(name)]}", f"spk_{order[root(name)]}")
            for name in names if root(name) in order
        }
        merged = len(names) - len(order)
        if merged <= 0:
            return segments, references, 0

        for seg in segments:
            moved = renamed.get(seg.speaker)
            if moved is None or seg.speaker_status != "attributed":
                continue
            seg.speaker, seg.speaker_key = moved
            for word in seg.words:
                # The word's own label follows its turn; its `speaker_raw` does
                # not, because that is the provider's answer and stays theirs.
                if word.speaker is not None:
                    word.speaker = moved[0]

        combined: dict[str, list[tuple[tuple[float, float], list[float]]]] = {}
        for name in names:
            moved = renamed.get(name)
            if moved:
                combined.setdefault(moved[0], []).extend(references[name].windows)
        rebuilt = {
            name: Reference(vector=_robust_centroid([v for _, v in windows]), windows=windows)
            for name, windows in combined.items()
        }
        return segments, rebuilt, merged

    # --- micro-turn islands -------------------------------------------------- #
    def _correct_islands(self, segments: list[Segment], references: dict[str, list[float]],
                         embed, report: Report) -> None:
        """Re-own a very short turn the provider filed under the wrong speaker.

        A different correction from `_merge_labels`, and the two must not be
        confused. That one asks *"are these two labels the same person for the
        whole meeting?"*. This one asks *"is this one turn filed under the wrong
        person, while its label goes on being a real person elsewhere?"* — and
        answering the second with the first would destroy a genuine speaker.

        The shape, from a real recording:

            02:38  Speaker 1   ................................
            02:41  Speaker 3   "Yeah."                    <- 0.4s
            02:41  Speaker 1   ................................
            ...
            03:25  Speaker 3   ................................  <- really them

        Correcting the tiny turn must leave 03:25 alone. Merging `C` into `A`
        would have taken a real participant out of the meeting.

        <h2>Adjacency is a filter, never a reason</h2>

        Being short and surrounded is only what makes a turn worth the cost of
        asking. Nothing is reassigned without acoustic evidence, because
        "somebody agreed briefly in the middle of a sentence" is one of the most
        ordinary things in a conversation, and a rule that flattened those would
        quietly delete every interjection in the product.

        The words are never read. "Yeah", "No", "Exactly" and "Sure" are the
        same input to this function; only the sound decides.
        """
        runs = _speaker_runs(segments)
        if len(runs) < 3:
            return
        for i in range(1, len(runs) - 1):
            run, before, after = runs[i], runs[i - 1], runs[i + 1]
            if run.speaker is None or before.speaker is None or after.speaker is None:
                continue
            if run.speaker == before.speaker:
                continue                       # not an island, just a neighbour
            if run.seconds > self._limits.island_max_seconds:
                continue                       # long enough to speak for itself

            report.islands_examined += 1
            owner = self._island_owner(run, before, after, references, embed)
            if owner is None:
                # Examined and unresolved. The provider's answer stands -- it is
                # still the best one available -- but it is now known to be
                # unconfirmed, and `app.naming` will not let an unconfirmed turn
                # be the evidence that puts a real person's name on a speaker.
                report.islands_ambiguous += 1
                for seg in run.segments:
                    seg.speaker_provisional = True
                continue
            if owner == run.speaker:
                continue                       # the provider was right
            report.islands_corrected += 1
            key = next((s.speaker_key for s in segments
                        if s.speaker == owner and s.speaker_key), None)
            for seg in run.segments:
                seg.speaker = owner
                seg.speaker_key = key
                for word in seg.words:
                    # The provider's own token stays on the word, exactly as it
                    # stays on the segment. Only ownership moves.
                    if word.speaker is not None:
                        word.speaker = owner

    def _island_owner(self, run, before, after, references, embed) -> str | None:
        """Whose voice the island actually is, or None for "cannot tell".

        Two ways of asking, chosen by whether there is enough audio to embed.
        """
        limits = self._limits
        direct = embed(run.start, run.end)
        if direct is not None:
            # Long enough to speak for itself. Rank it against every voice in
            # the meeting and require a clear winner -- including over the
            # speaker it is currently filed under, which is one of the
            # candidates rather than a default.
            return _clear_best(direct, references, limits.assign_margin)

        # Too short for the embedder, which refuses below `MIN_SPAN_SECONDS`
        # rather than returning a vector it does not believe. That refusal is
        # information: a turn this short cannot be identified on its own, so the
        # question changes from "whose is this?" to **"is there a second voice
        # in here at all?"** -- asked once per side.
        #
        # For each neighbour, two windows of the same length: one that *spans*
        # the island and reaches into that neighbour, and one lying entirely
        # inside the neighbour. If the island belongs to them, adding it costs
        # their score nothing; if it is somebody else, the spanning window is
        # contaminated and drops.
        #
        # The control is what makes this safe. A spanning window is mostly
        # neighbour audio by construction -- the island is a fraction of a
        # second -- so scoring it against an absolute threshold would say "yes"
        # every time. Scoring it against pure neighbour of the same length asks
        # only about the difference the island made.
        span = limits.island_probe_seconds
        centre = (run.start + run.end) / 2
        probe = embed(centre - span / 2, centre + span / 2)

        # Strong positive evidence for the provider's own answer wins outright:
        # a real interjection by somebody established elsewhere in the meeting.
        own = references.get(run.speaker)
        if probe is not None and own is not None:
            rivals = [cosine(probe, references[side.speaker])
                      for side in (before, after) if side.speaker in references]
            if rivals and cosine(probe, own) > max(rivals):
                return run.speaker

        if before.speaker != after.speaker:
            # REVERTED. Correcting islands whose neighbours differ was added and
            # then withdrawn: it is the only mechanism able to move the *start*
            # of a legitimate turn onto the speaker before it, and three
            # production regressions had exactly that shape. The evidence for
            # the expansion was synthetic; the evidence against it was a real
            # meeting. With differing neighbours there is no continuous reading
            # to test against, nothing is assumed from either side, and the
            # provider's attribution stands.
            return None

        agreed: set[str] = set()
        for side, spanning, control in (
            (before, (run.end - span, run.end), (run.start - span, run.start)),
            (after, (run.start, run.start + span), (run.end, run.end + span)),
        ):
            reference = references.get(side.speaker)
            if reference is None:
                continue
            with_island = embed(*spanning)
            without = embed(*control)
            if with_island is None or without is None:
                continue
            if cosine(with_island, reference) >= cosine(without, reference) - limits.island_tolerance:
                agreed.add(side.speaker)

        if len(agreed) == 1:
            # Exactly one neighbour's audio runs through the island unbroken.
            # Where the neighbours are the same person this is the continuous
            # reading; where they differ it is the side the island belongs to.
            return agreed.pop()
        # Nobody, or both -- in which case the island is equally at home on
        # either side and there is nothing to choose between them.
        return None

    # --- under-diarization at the label level -------------------------------- #
    def _split_labels(self, segments: list[Segment], references: dict[str, "Reference"],
                      embed, report: Report):
        """Separate one canonical speaker that is really two people.

        The mirror of `_merge_labels`, and needed for the same reason: the
        provider is wrong in both directions. A real transcript had a
        substantial turn nine minutes in reading as the person who spoke at two
        minutes, and it was somebody else entirely -- one provider label
        covering two voices for the whole meeting.

        Neither the split search nor the island correction can reach that. Both
        assume the canonical speakers are the right *set* of people and only
        argue about which turns belong to whom; this is about the set being
        wrong.

        <h2>Judged against the label's own spread, like everything else here</h2>

        A speaker's windows are clustered in two, and the split happens only
        when the two groups are **further apart than either group is from
        itself** -- the same self-calibrating rule the merge uses, pointed the
        other way. A voice recorded across changing conditions varies, and this
        must not fire on that; two people under one label do not merely vary,
        they separate.

        A group must also hold real speech before it can become a speaker, so a
        single odd window cannot found a person.
        """
        limits = self._limits
        out: dict[str, Reference] = {}
        renumber: list[str] = []

        for name, reference in references.items():
            if not reference.heterogeneous:
                out[name] = reference
                continue
            groups = _bisect(reference.windows)
            if groups is None:                     # unreachable; the flag implies it
                out[name] = reference
                continue
            first, second = groups
            report.labels_would_split += 1
            logger.info(
                "Substantial-turn analysis: decision=split regions=%d "
                "leftRegions=%d rightRegions=%d across=%.2f applied=%s",
                len(reference.windows), len(first), len(second),
                _cross_similarity(first, second), limits.split_labels_enabled,
            )
            if not limits.split_labels_enabled:
                # Observed, not acted on. Re-enabling this needs evidence from a
                # real recording, and this is how that evidence is gathered
                # without the recording being the experiment.
                out[name] = reference
                continue
            renumber.append(name)
            out[name] = Reference(
                vector=_robust_centroid([v for _, v in first]), windows=first)
            out[_other_half(name)] = Reference(
                vector=_robust_centroid([v for _, v in second]), windows=second)

        if not renumber:
            return segments, references
        return self._apply_label_split(segments, out, renumber, embed, report)

    def _apply_label_split(self, segments, references, renumber, embed, report):
        """Give each of the split speaker's turns to whichever half it matches."""
        halves = {name: (name, _other_half(name)) for name in renumber}
        assignment: dict[int, str] = {}
        for index, seg in enumerate(segments):
            pair = halves.get(seg.speaker)
            if pair is None or seg.speaker_status != "attributed":
                continue
            middle = (float(seg.start) + float(seg.end)) / 2
            span = min(_duration(seg), self._limits.reference_window_seconds)
            vector = embed(middle - span / 2, middle + span / 2)
            if vector is None:
                continue                       # too thin to move; stays put
            best = _clear_best(
                vector,
                {half: references[half].vector for half in pair},
                self._limits.assign_margin,
            )
            if best is not None and best != seg.speaker:
                assignment[index] = best
        if not assignment:
            # Nothing could be moved with confidence, so the split describes
            # nobody and is abandoned rather than left half-applied.
            return segments, {n: r for n, r in references.items() if not _is_half(n)}

        for index, half in assignment.items():
            segments[index].speaker = half
        report.labels_split += len(renumber)
        report.substantial_reassigned += len(assignment)
        return self._renumber(segments, references)

    def _renumber(self, segments, references):
        """Canonical numbering by first appearance, after a split created names."""
        order: dict[str, int] = {}
        for seg in segments:
            if seg.speaker_status == "attributed" and seg.speaker and seg.speaker not in order:
                order[seg.speaker] = len(order) + 1
        renamed = {old: (f"Speaker {n}", f"spk_{n}") for old, n in order.items()}
        for seg in segments:
            moved = renamed.get(seg.speaker)
            if moved is None or seg.speaker_status != "attributed":
                continue
            seg.speaker, seg.speaker_key = moved
            for word in seg.words:
                if word.speaker is not None:
                    word.speaker = moved[0]
        return segments, {
            renamed[name][0]: reference
            for name, reference in references.items() if name in renamed
        }

    def _one_voice(self, a: str, b: str, score: float,
                   references: dict[str, "Reference"], names: list[str]) -> bool:
        """Whether two labels are one person, judged against their own spread.

        A high similarity is not evidence by itself, and this is the whole
        reason merging is safe to attempt at all. Two labels scoring 0.99:

        * if either label's own windows only manage 0.95 among themselves, then
          the two labels agree with each other **better than either agrees with
          itself** — which one voice recorded twice does, and two voices cannot;
        * if both labels manage 0.999 internally, 0.99 is a real gap, and the
          honest reading is two people this model renders very similarly.

        Same number, opposite conclusions, and nothing separates them but the
        recording's own scale. A fixed threshold has to pick one of the two
        readings in advance and is wrong for every meeting it guessed against.

        A label with a single window has no spread to measure and is never
        merged: there is no way to calibrate, and an uncalibrated merge is the
        guess this exists to avoid.
        """
        if references[a].heterogeneous or references[b].heterogeneous:
            # One of these labels disagrees with itself, so its reference is an
            # average of two people. An average of two people can resemble a
            # third convincingly, and merging on it is how two real humans end
            # up under one name.
            return False
        own_a, own_b = references[a].consistency, references[b].consistency
        if own_a is None or own_b is None:
            return False
        if score < min(own_a, own_b):
            return False

        # One cosine between two averages is not meeting-wide evidence, and the
        # cost of being wrong is not symmetrical: two labels left on one person
        # is a rename away, while two people under one name corrupts the talk
        # time, the attribution of every action item, the summary, retrieval and
        # the export at once, invisibly. So two further checks, both of which a
        # genuine duplicate passes easily.

        # Every window of one against every window of the other. A label whose
        # own audio is bimodal -- one person early, another later -- can have an
        # average that sits between them and matches another label's average
        # convincingly, while not one of its actual windows does.
        if _cross_similarity(references[a].windows, references[b].windows,
                             worst=True) < self._limits.merge_similarity:
            return False

        # And the pair has to be closer to each other than either is to anybody
        # else by a clear margin. Where a third voice is nearly as close, these
        # references are not discriminating between people at all.
        for other in names:
            if other in (a, b):
                continue
            near_a = cosine(references[a].vector, references[other].vector)
            near_b = cosine(references[b].vector, references[other].vector)
            if max(near_a, near_b) >= self._limits.merge_similarity:
                # Not a rival: a third label of the same person, which is what
                # a provider that split one voice five ways produces. Counting
                # it as competition would make every duplicate protect every
                # other duplicate from being recognised.
                continue
            if score - max(near_a, near_b) < self._limits.merge_margin:
                return False
        return True

    def _reference_windows(self, seg: Segment) -> list[tuple[float, float]]:
        """Stretches of this turn safe enough to say what its speaker sounds like.

        A turn no longer than `reference_to_seconds` is used whole: it is too
        short to be concealing anybody, which is the property the old rule was
        built on and is still true. Anything longer is sampled from its interior,
        inset at both ends.
        """
        limits = self._limits
        lo, hi = float(seg.start), float(seg.end)
        length = hi - lo
        if length <= 0:
            return []
        if length <= limits.reference_to_seconds:
            return [(lo, hi)]

        inner_lo = lo + limits.reference_window_inset_seconds
        inner_hi = hi - limits.reference_window_inset_seconds
        usable = inner_hi - inner_lo
        window = limits.reference_window_seconds
        if usable < window:
            # Long enough to be suspect, too short to sample safely once the
            # edges are removed. Contributing its middle anyway would be using
            # the one part of it this rule exists to distrust.
            return []

        count = min(int(usable // window), limits.reference_windows_per_turn)
        # Spread across the interior rather than packed at the front, so a turn
        # that does hide a second speaker contributes windows from both halves
        # and is caught by the outlier drop below rather than vouching for
        # itself.
        gap = (usable - count * window) / (count + 1)
        return [
            (inner_lo + gap * (i + 1) + window * i, inner_lo + gap * (i + 1) + window * (i + 1))
            for i in range(count)
        ]

    def _spread(self, regions: list) -> list:
        """At most `reference_windows_max`, taken evenly across the meeting.

        Evenly rather than the first N: a speaker's opening turn is often them
        reading an agenda in a different register, and a reference built only
        from it describes a voice they spend the rest of the meeting not using.
        """
        limit = self._limits.reference_regions_max
        if len(regions) <= limit:
            return regions
        step = len(regions) / limit
        return [regions[int(i * step)] for i in range(limit)]

    # --- the search --------------------------------------------------------- #
    def _resolve(self, seg: Segment, references, identities, embed, report: Report,
                 *, depth: int) -> list[Segment]:
        """Split this turn if the audio says so, then reconsider each half."""
        if depth <= 0 or _duration(seg) < self._limits.examine_from_seconds:
            return [seg]
        if len(seg.words) < 4:
            return [seg]

        split = self._best_split(seg, references, embed)
        if split is None:
            return [seg]

        index, left_speaker, right_speaker = split
        left, right = self._cut(seg, index, left_speaker, right_speaker, identities)
        if left is None or right is None:
            return [seg]
        report.split += 1
        return [
            *self._resolve(left, references, identities, embed, report, depth=depth - 1),
            *self._resolve(right, references, identities, embed, report, depth=depth - 1),
        ]

    def _candidates(self, seg: Segment) -> list[int]:
        """Word indices where a split could start, coarse then fine.

        Coarse-to-fine rather than a fixed step, so the cost of examining a
        sixty-second turn is the cost of examining a ten-second one. Boundaries
        are always word boundaries: a split inside a word would produce two
        fragments that each read as a transcription error.
        """
        limits = self._limits
        lo, hi = float(seg.start), float(seg.end)
        usable = [
            i for i, w in enumerate(seg.words)
            if i > 0
            and float(w.start) - lo >= limits.min_side_seconds
            and hi - float(w.start) >= limits.min_side_seconds
        ]
        if len(usable) <= limits.coarse_candidates:
            return usable
        step = len(usable) / limits.coarse_candidates
        return [usable[int(i * step)] for i in range(limits.coarse_candidates)]

    def _score(self, seg: Segment, index: int, references, embed):
        """`(score, left, right)` for one candidate, or None if it is refused."""
        boundary = float(seg.words[index].start)
        left = embed(float(seg.start), boundary)
        right = embed(boundary, float(seg.end))
        if left is None or right is None:
            return None

        def best_two(vec):
            ranked = sorted(
                ((cosine(vec, ref), name) for name, ref in references.items()),
                reverse=True,
            )
            return ranked[0], (ranked[1] if len(ranked) > 1 else (0.0, None))

        (ls, lname), (l2, _) = best_two(left)
        (rs, rname), (r2, _) = best_two(right)

        if lname == rname:
            return None                                    # one voice throughout
        if ls - l2 < self._limits.assign_margin:
            return None                                    # left is ambiguous
        if rs - r2 < self._limits.assign_margin:
            return None                                    # right is ambiguous
        pair = cosine(left, right)
        if pair > self._limits.max_side_similarity:
            return None                                    # the halves match each other
        return ((ls + rs) / 2 - pair, lname, rname)

    def _best_split(self, seg: Segment, references, embed):
        best = None
        for index in self._candidates(seg):
            scored = self._score(seg, index, references, embed)
            if scored and (best is None or scored[0] > best[0]):
                best = (scored[0], index, scored[1], scored[2])
        if best is None:
            return None

        # Fine pass: the coarse winner is within one coarse step of the real
        # boundary, and a boundary half a second out puts a whole clause under
        # the wrong name.
        _, index, lname, rname = best
        for near in self._neighbours(seg, index):
            scored = self._score(seg, near, references, embed)
            if scored and scored[0] > best[0]:
                best = (scored[0], near, scored[1], scored[2])
        return (best[1], best[2], best[3])

    def _neighbours(self, seg: Segment, index: int) -> list[int]:
        limits = self._limits
        lo, hi = float(seg.start), float(seg.end)
        centre = float(seg.words[index].start)
        window = max(limits.fine_step_seconds, _duration(seg) / limits.coarse_candidates)
        return [
            i for i, w in enumerate(seg.words)
            if i > 0 and i != index
            and abs(float(w.start) - centre) <= window
            and float(w.start) - lo >= limits.min_side_seconds
            and hi - float(w.start) >= limits.min_side_seconds
        ]

    # --- applying it -------------------------------------------------------- #
    def _cut(self, seg: Segment, index: int, left_speaker: str, right_speaker: str,
             identities) -> tuple[Segment | None, Segment | None]:
        """Two segments where there was one, each under an existing speaker.

        The identities are copied from segments that already carry them, so a
        repair can only ever move words between people who were already in the
        meeting. There is no branch here that mints a speaker key, which is what
        keeps canonical numbering, colours, talk-time and voice profiles
        undisturbed by a correction.
        """
        left_words = seg.words[:index]
        right_words = seg.words[index:]
        if not left_words or not right_words:
            return None, None

        if left_speaker not in identities or right_speaker not in identities:
            return None, None

        boundary = float(right_words[0].start)
        left = self._rebuild(seg, left_words, float(seg.start), boundary,
                             identities[left_speaker], capitalise=False)
        right = self._rebuild(seg, right_words, boundary, float(seg.end),
                              identities[right_speaker], capitalise=True)
        return left, right

    def _rebuild(self, seg: Segment, words: list[Word], start: float, end: float,
                 identity: tuple[str, str | None, str], *, capitalise: bool) -> Segment:
        speaker, key, status = identity
        # The word keeps its own `speaker_raw` — that is the provider's record
        # of what it thought, and overwriting it would erase the evidence that
        # this segment was repaired at all. `app.diarization.trace_lines` reads
        # both, and a raw column that agreed with the canonical one everywhere
        # would make the trace useless for exactly the case it exists for.
        moved = [w.model_copy(update={"speaker": speaker}) for w in words]
        return seg.model_copy(update={
            "start": start,
            "end": end,
            "speaker": speaker,
            "speaker_key": key,
            "speaker_status": status,
            "words": moved,
            # The right-hand fragment begins mid-utterance because it was split
            # out, so its first word is lower-cased where a sentence would not
            # be. Same liberty `split_by_speaker` already takes, and the same
            # reason: "…and monitor production." reads as a broken line rather
            # than as a turn.
            "text": join_words(moved, capitalise=capitalise) or seg.text,
        })
