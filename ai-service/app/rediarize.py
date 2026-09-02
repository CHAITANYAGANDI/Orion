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
from app.regions import (
    Cluster,
    Region,
    consistency as _consistency,
    separated,
    one_voice,
    reconcile,
    robust_centroid as _robust_centroid,
)
from app.schemas import Segment, Word
from app.voiceprints import cosine

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

    #: Regions a label needs before the minority of them may be held back.
    #: Two, not three: a label carrying exactly one turn of somebody else's
    #: is the commonest shape of the failure, and there is no third region
    #: to break the tie with. What makes it safe at two is that the rule is
    #: self-calibrating -- with one region each side there is no measurable
    #: internal spread, so the bar falls back to a flat `split_margin` below
    #: perfect agreement, which two recordings of one voice clear easily --
    #: and that holding a region back never moves it anywhere by itself.
    withhold_min_regions: int = 2

    #: Region-to-region comparisons a merge has to rest on. Two labels that
    #: each spoke once produce exactly one, and one cosine from one model
    #: over one stretch of audio is the claim this module exists to refuse.
    #: If either is really a duplicate of a third label that did speak
    #: twice, the merge still reaches them through it.
    merge_min_comparisons: int = 2
    #: The share of those comparisons that must clear `merge_similarity`.
    #: Not all of them: six regions a side is thirty-six comparisons, and
    #: demanding unanimity lets one unlucky region -- a cough, an overlap, a
    #: laugh -- refuse a merge the other thirty-five support. Safe only
    #: because a label whose regions really split into two voices has had
    #: the minority withheld before this is asked.
    merge_agreement: float = 0.75

    #: How much audio a withheld region needs before it may be given to a
    #: different voice. Far above the embedder's own 0.8s floor, because a
    #: fragment identified from one second of audio is the shape of every
    #: regression this module has caused. A region that cannot clear it
    #: simply stays where the provider put it.
    reassign_min_seconds: float = 2.0

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

    #: The region-level view of the same meeting. `merged` counts labels
    #: folded together; these count the individual turns that were embedded,
    #: held back from their label's own reference, and -- through
    #: `substantial_reassigned` -- given to a different voice.
    regions: int = 0
    regions_withheld: int = 0
    #: Label pairs that landed in the maybe-band and were left as two
    #: speakers. Non-zero is not a failure; it is the error-cost policy
    #: working, and it is worth seeing because it used to abandon merging
    #: for the entire meeting rather than for the pair.
    merge_ambiguous: int = 0

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
            f"heterogeneousLabels={self.heterogeneous_labels} "
            f"regions={self.regions} "
            f"regionsWithheld={self.regions_withheld} "
            f"mergeAmbiguousPairs={self.merge_ambiguous}"
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


def _duration(seg: Segment) -> float:
    return max(0.0, float(seg.end) - float(seg.start))


def _identity_of(seg: Segment) -> tuple[str, str | None, str]:
    return (seg.speaker, seg.speaker_key, seg.speaker_status)


def _reference_of(regions: Sequence[Region], limits: Limits) -> Reference:
    """One label's regions, as the reference the rest of this module reads."""
    return Reference(
        vector=_robust_centroid([region.vector for region in regions]),
        windows=[((region.start, region.end), region.vector) for region in regions],
        samples=[vec for region in regions for vec in region.samples],
        heterogeneous=_holds_two_voices(regions, limits),
    )


def _holds_two_voices(regions: Sequence[Region], limits: Limits) -> bool:
    """Whether this label's own regions fall into two separated voices.

    Detection, and nothing else. What it is used for is making the merge refuse:
    a label that disagrees with itself has a reference describing an average of
    two people, and an average of two people can resemble a third convincingly.
    """
    split = separated(regions, limits)
    if split is None:
        return False
    return sum(region.seconds for region in split[1]) >= limits.reference_floor_seconds


def _cluster_of(name: str, reference: Reference) -> Cluster:
    """A `Reference` seen as the regions it was built from."""
    return Cluster(
        key=name,
        regions=[
            Region(index=index, start=lo, end=hi, seconds=hi - lo,
                   vector=vector, samples=[vector])
            for index, ((lo, hi), vector) in enumerate(reference.windows)
        ],
        heterogeneous=reference.heterogeneous,
    )


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
        self._trace_enabled: bool | None = None

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

        priors = self._regions(segments, embed)
        refs = {name: _reference_of(found, self._limits)
                for name, found in priors.items()}
        report.references = len(refs)
        report.regions = sum(len(found) for found in priors.values())
        report.heterogeneous_labels = sum(1 for r in refs.values() if r.heterogeneous)
        report.canonical_speakers = len(refs)
        if len(refs) < 2:
            report.skipped_reason = "fewer than two speakers with usable reference audio"
            return segments, report

        # Everything above this line still reasons in provider-label space,
        # because a label is what the provider handed over. Everything below it
        # reasons in region space, and `app.regions` is the crossing: it decides
        # which labels are one voice, which individual turns were filed under
        # the wrong one, and what the canonical numbering should be -- from the
        # audio, with the provider's labels as a prior rather than a constraint.
        #
        # It replaced two separate passes that each argued about labels. They
        # could fold two labels together and they could notice a label holding
        # two people, but neither could say *which turn* was the wrong one, so
        # the commonest failure in the evidence -- one voice alternating between
        # two labels for a whole meeting, with a single foreign turn under one
        # of them -- was unreachable from either.
        segments, refs = self._reconcile(segments, priors, report)
        if len(refs) < 2:
            # One voice, recorded under several labels. Nothing left to split
            # against, and the reconciliation is still worth keeping.
            report.skipped_reason = "one voice once the provider's labels were merged"
            return segments, report

        references = {name: ref.vector for name, ref in refs.items()}
        # The best-separated pair in the meeting, not the worst.
        #
        # This used to take the worst, and decline everything if any two
        # speakers were closer than the bar. The reasoning was that a model
        # which cannot separate two voices in this recording is guessing about
        # all of them -- and in a two-speaker meeting that is exactly right, and
        # is still what happens here, because with one pair the best and the
        # worst are the same number.
        #
        # In a six-speaker meeting it is not right at all. Two participants who
        # happen to sound alike silenced every correction for the other four,
        # including corrections resting on margins of 0.9 against 0.1. The real
        # meeting has six labels and a pair at 0.62, and this branch is why not
        # one of its mislabelled fragments was ever examined.
        #
        # What protects the confusable pair is not this gate but the margin each
        # decision carries in its own right: `_clear_best` refuses whenever the
        # top two candidates are within `assign_margin`, which is the same
        # judgement made where it applies rather than everywhere. So the gate
        # now asks the only question that is genuinely about the recording --
        # can this model tell *anybody* here apart? -- and leaves the rest to
        # the decisions.
        apart = min(
            cosine(a, b)
            for i, a in enumerate(references.values())
            for b in list(references.values())[i + 1:]
        )
        if apart > self._limits.max_reference_similarity:
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
            report.skipped_reason = f"speakers too alike to judge (cos={apart:.2f})"
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
    def _references(self, segments: Sequence[Segment], embed) -> dict[str, "Reference"]:
        """What each provider label sounds like, before anything is reconciled."""
        return {name: _reference_of(found, self._limits)
                for name, found in self._regions(segments, embed).items()}

    def _regions(self, segments: Sequence[Segment], embed) -> dict[str, list[Region]]:
        """One embedded region per turn, grouped by the label the provider gave it.

        <h2>Why a region and not a window</h2>

        The rule this replaced took short turns *exclusively* whenever their
        total reached the floor, and only looked at long ones when it did not.
        Being short makes a turn trustworthy -- it is too brief to be concealing
        a second speaker -- and the rule treated that as making it sufficient.
        In a real meeting one provider label held 157 seconds across seven
        turns; eleven of them were short, so **146 seconds were never looked
        at**, and four of the eleven were a turn the provider had attributed to
        the wrong person. A third of that speaker's whole reference was somebody
        else's voice, with a minute and a half of their own sitting unread.

        So every turn contributes now -- a short one whole, a long one through
        its interior windows:

            turn A, 20s  ->  |--inset--|  win  |  win  |  win  |--inset--|

        The insets are the point. A speaker change the provider missed is most
        likely at the *edges* of what it labelled, because that is where its
        boundary went wrong, so the interior is the part least likely to belong
        to somebody else.

        <h2>One turn, one vote</h2>

        However many windows fit inside a turn, they are collapsed to a single
        vector before it counts. A ninety-second turn is better evidence than a
        four-second one and is not fifteen *independent* observations of it;
        letting it contribute fifteen vectors would outvote every region it
        ought to be corroborated by, and would make robust aggregation a
        formality.

        Nothing here reads a word of transcript. Regions are chosen by the
        clock, and the only thing consulted is the sound.
        """
        floor = self._limits.reference_floor_seconds
        candidates: dict[str, list[tuple[int, Segment, list[tuple[float, float]]]]] = {}
        for index, seg in enumerate(segments):
            if seg.speaker_status != "attributed" or not seg.speaker:
                continue
            spans = self._reference_windows(seg)
            if spans:
                candidates.setdefault(seg.speaker, []).append((index, seg, spans))

        built: dict[str, list[Region]] = {}
        for speaker, found in candidates.items():
            regions: list[Region] = []
            sampled = 0.0
            for index, seg, spans in self._spread(found):
                vectors = [v for v in (embed(lo, hi) for lo, hi in spans) if v]
                if not vectors:
                    continue
                seconds = sum(hi - lo for lo, hi in spans)
                regions.append(Region(
                    index=index,
                    start=float(seg.start),
                    end=float(seg.end),
                    seconds=seconds,
                    vector=_robust_centroid(vectors),
                    samples=vectors,
                ))
                sampled += seconds
            if regions and sampled >= floor:
                built[speaker] = regions
        return built

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

    # --- reconciliation ------------------------------------------------------ #
    def _reconcile(self, segments: list[Segment], priors: dict[str, list[Region]],
                   report: Report):
        """Decide the canonical voices, then write them onto the segments.

        The decision itself is in `app.regions`; this is the part that touches
        the transcript. Three things move and one does not:

        * `speaker` and `speaker_key` become the reconciled identity;
        * every word's `speaker` follows its turn;
        * `speaker_raw` is never touched, on the segment or on any word. It is
          the provider's own answer, it is what makes a repair reversible and a
          complaint traceable, and a raw column that agreed with the canonical
          one everywhere would make the trace useless for exactly the case it
          exists for.
        """
        outcome = reconcile(priors, self._limits, trace=self._trace)
        report.merged = outcome.merged
        report.merge_ambiguous = outcome.ambiguous
        report.regions_withheld = outcome.withheld
        report.substantial_reassigned = outcome.reassigned
        report.heterogeneous_labels = outcome.heterogeneous
        report.labels_would_split = outcome.would_split
        report.labels_split = outcome.split

        numbers = self._numbering(segments, outcome)
        self._trace_regions(segments, priors, outcome, numbers)
        for index, seg in enumerate(segments):
            if seg.speaker_status != "attributed" or not seg.speaker:
                continue
            key = outcome.moved.get(index) or outcome.mapping.get(seg.speaker, seg.speaker)
            number = numbers.get(key)
            if number is None:
                continue
            if key not in outcome.clusters:
                # A provider label with no embeddable stretch anywhere in the
                # meeting. `split_by_speaker` will promote a two-word run inside
                # an otherwise stable utterance to a turn of its own -- rightly,
                # because a one-word "Exactly." is a real turn and the adapter
                # has no audio to tell the two apart -- and where every one of a
                # label's appearances is that short, the only evidence it is a
                # person is the provider's word.
                #
                # It keeps its identity, because overruling the provider on
                # silence is not better than believing it. What it does not get
                # is the standing to carry somebody's name: `app.naming` reads
                # this flag and will not put a real person on a turn whose
                # ownership was never verifiable.
                seg.speaker_provisional = True
            seg.speaker, seg.speaker_key = f"Speaker {number}", f"spk_{number}"
            for word in seg.words:
                if word.speaker is not None:
                    word.speaker = seg.speaker

        refs = {
            f"Speaker {numbers[key]}": _reference_of(outcome.clusters[key].regions,
                                                     self._limits)
            for key in outcome.order
            if key in numbers and outcome.clusters.get(key)
            and outcome.clusters[key].regions
        }
        report.canonical_speakers = len({
            seg.speaker for seg in segments
            if seg.speaker_status == "attributed" and seg.speaker
        })
        return segments, refs

    def _numbering(self, segments: Sequence[Segment], outcome) -> dict[str, int]:
        """`Speaker N` by first **stable** appearance.

        Numbering used to run on first appearance of any kind, and that is how a
        half-second fragment the provider mislabelled took `Speaker 2` and
        pushed every real participant along behind it. The fragment was below
        the embedder's floor, so there was never any evidence it was a person at
        all -- and because the ordinal was spent, the shift was permanent and
        showed up in colours, talk time and every export.

        `app.regions` orders the voices it could actually hear. What is added
        here is everybody else: a label with too little audio to embed keeps its
        identity, because the provider said somebody spoke and this module does
        not overrule that on silence, but it is numbered *after* the people the
        meeting can hear, so it cannot renumber them.
        """
        order = list(outcome.order)
        for seg in segments:
            if seg.speaker_status != "attributed" or not seg.speaker:
                continue
            key = outcome.mapping.get(seg.speaker, seg.speaker)
            if key not in order:
                order.append(key)
        return {key: number for number, key in enumerate(order, start=1)}

    def _one_voice(self, a: str, b: str, score: float,
                   references: dict[str, "Reference"], names: list[str]) -> bool:
        """Whether two labels are one person, judged against their own spread.

        A thin adapter over `app.regions.one_voice`, which is where the rule
        lives now that it is expressed over regions rather than over one
        averaged vector per label. Kept here because it is the narrowest way to
        state the merge contract in a test.
        """
        clusters = {name: _cluster_of(name, references[name]) for name in names}
        return one_voice(clusters[a], clusters[b], score, clusters, names,
                         self._limits, lambda *args, **fields: None)

    # --- diagnostics ---------------------------------------------------------- #
    @property
    def _tracing(self) -> bool:
        if self._trace_enabled is None:
            try:
                from app.config import get_settings

                self._trace_enabled = bool(get_settings().diarization_trace)
            except Exception:  # noqa: BLE001 - absent settings is not a failure
                self._trace_enabled = False
        return self._trace_enabled

    def _trace(self, kind: str, **fields) -> None:
        """One line per reconciliation decision, off unless someone asks.

        Timestamps, durations, counts and similarities. No names, no words, no
        vectors and no provider tokens -- which is what makes it safe to turn on
        at INFO in a deployment holding other people's meetings, and that is the
        only kind of deployment where the questions it answers can be asked.
        """
        if not self._tracing:
            return
        logger.info(
            "Speaker reconciliation %s %s", kind,
            " ".join(f"{key}={value}" for key, value in fields.items()),
        )

    def _trace_regions(self, segments: Sequence[Segment], priors, outcome,
                       numbers: dict[str, int]) -> None:
        """Every region, with the provider's prior beside the verdict.

        The trace that settles whose mistake a wrong speaker is. For each turn
        it gives the number the provider's clustering implied, how many raw word
        labels the provider used inside it, how consistent that label's own
        regions are, which canonical voice the audio is actually nearest, and
        what the turn ended up as. Where the prior and the final differ, this
        module moved it; where they agree and both are wrong, the provider did,
        and nothing here will fix it.

        `wordLabels` is the one that answers a question no other line can: a
        turn that exists only because the provider changed its mind for two
        words inside an otherwise stable utterance shows up here as a region
        whose parent utterance carried more than one label.
        """
        if not self._tracing:
            return
        voices = {key: cluster for key, cluster in outcome.clusters.items()
                  if key in numbers and cluster.regions}
        # The provider's own labels, as ordinals rather than tokens. This is the
        # column that answers the question: consecutive regions reading
        # `providerLabel=1 2 1 2` mean the provider alternated and Reverie
        # reproduced it; all reading `1` mean the alternation was made here.
        # A number rather than the token itself, because a provider that runs
        # speaker identification returns real names in that field.
        ordinals = {label: index for index, label in enumerate(priors, start=1)}
        for label, regions in priors.items():
            prior = outcome.mapping.get(label, label)
            spread = _consistency([region.vector for region in regions])
            for region in regions:
                ranked = sorted(
                    ((cosine(region.vector, cluster.vector), key)
                     for key, cluster in voices.items()), reverse=True)
                near, nearest = ranked[0] if ranked else (0.0, None)
                words = segments[region.index].words
                logger.info(
                    "Speaker reconciliation region at=%.2f seconds=%.1f "
                    "providerLabel=%d wordLabels=%d priorSpeaker=%s "
                    "labelRegions=%d labelConsistency=%s nearest=%s "
                    "similarity=%.3f finalSpeaker=%s",
                    region.start, region.seconds, ordinals[label],
                    len({w.speaker_raw for w in words if w.speaker_raw}),
                    numbers.get(prior), len(regions),
                    "none" if spread is None else f"{spread:.3f}",
                    numbers.get(nearest), near,
                    numbers.get(outcome.moved.get(region.index, prior)),
                )

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
        """At most `reference_regions_max`, taken evenly across the meeting.

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
