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
from dataclasses import dataclass
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
    #: And across the whole meeting, per speaker. Bounds the embedding cost.
    reference_windows_max: int = 6

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

    @property
    def changed(self) -> bool:
        # Merging renames turns, so it changes the transcript as surely as a
        # split does and the flat text has to be rebuilt either way.
        return self.split > 0 or self.merged > 0

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
            f"splitTurns={self.split}"
        )


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

        references, consistency = self._references(segments, embed)
        report.references = len(references)
        report.canonical_speakers = len(references)
        if len(references) < 2:
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
        segments, references, merged = self._merge_labels(segments, references, consistency)
        report.merged = merged
        report.canonical_speakers = len(references)
        if len(references) < 2:
            # One voice, recorded under several labels. Nothing left to split
            # against, and the merge is still worth keeping.
            report.skipped_reason = "one voice once the provider's labels were merged"
            return segments, report

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
        safe: dict[str, list[tuple[float, float]]] = {}
        fallback: dict[str, list[tuple[float, float]]] = {}
        for seg in segments:
            if seg.speaker_status != "attributed" or not seg.speaker:
                continue
            if _duration(seg) <= self._limits.reference_to_seconds:
                safe.setdefault(seg.speaker, []).append((float(seg.start), float(seg.end)))
            else:
                fallback.setdefault(seg.speaker, []).extend(self._reference_windows(seg))

        references: dict[str, list[float]] = {}
        consistency: dict[str, float] = {}
        for speaker in {*safe, *fallback}:
            spans = safe.get(speaker, [])
            if sum(hi - lo for lo, hi in spans) < floor:
                # Only now. Short turns remain the better evidence and are used
                # alone wherever there are enough of them, so every meeting the
                # old rule handled is scored from exactly the audio it used.
                # The windows are what a meeting of long turns has instead of
                # nothing.
                spans = spans + self._spread(fallback.get(speaker, []))
            chosen = self._spread(spans)
            if sum(hi - lo for lo, hi in chosen) < floor:
                continue
            vectors = [v for v in (embed(lo, hi) for lo, hi in chosen) if v]
            if not vectors:
                continue
            references[speaker] = _robust_centroid(vectors)
            spread = _consistency(vectors)
            if spread is not None:
                consistency[speaker] = spread
        return references, consistency

    # --- over-diarization --------------------------------------------------- #
    def _merge_labels(self, segments: list[Segment], references: dict[str, list[float]],
                      consistency: dict[str, float]):
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
                score = cosine(references[a], references[b])
                if score < limits.merge_similarity - limits.merge_margin:
                    continue                      # comfortably two people
                if score < limits.merge_similarity:
                    # Possibly the same person. "Possibly" is not a reason to
                    # merge anybody, here or anywhere else in this meeting.
                    return segments, references, 0
                if not self._one_voice(a, b, score, consistency):
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

        combined: dict[str, list[list[float]]] = {}
        for name in names:
            moved = renamed.get(name)
            if moved:
                combined.setdefault(moved[0], []).append(references[name])
        return segments, {k: _robust_centroid(v) for k, v in combined.items()}, merged

    def _one_voice(self, a: str, b: str, score: float, consistency: dict[str, float]) -> bool:
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
        own_a, own_b = consistency.get(a), consistency.get(b)
        if own_a is None or own_b is None:
            return False
        return score >= min(own_a, own_b)

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

    def _spread(self, spans: list[tuple[float, float]]) -> list[tuple[float, float]]:
        """At most `reference_windows_max`, taken evenly across the meeting.

        Evenly rather than the first N: a speaker's opening turn is often them
        reading an agenda in a different register, and a reference built only
        from it describes a voice they spend the rest of the meeting not using.
        """
        limit = self._limits.reference_windows_max
        if len(spans) <= limit:
            return spans
        step = len(spans) / limit
        return [spans[int(i * step)] for i in range(limit)]

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
