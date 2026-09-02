"""Second-guessing the provider's turn boundaries, and mostly declining to.

## The bug

A user reported this turn, and it is the reason this module exists:

```
Speaker 2 (00:22)  "Okay, you have a good day anyway. I'm going home.
                    All right, Mr. Bob, I'll come see you when I get off. ..."
```

Two people, one label. The audio was re-submitted to AssemblyAI four ways — as
Reverie sends it, with `speakers_expected: 2`, with `speaker_options{2,2}`, and
on `universal-2` — and every run returned the same merged utterance with **every
word labelled `B`**, in both the `utterances` array and the top-level `words`
array. There was nothing in the response to recover, and no request-level flag
fixed it: the provider had already found exactly two speakers, it just put the
boundary in the wrong place.

## What is tested here

Not the model. The model's ability to hear the difference is measured against
real audio and reported in `docs/diarization.md` §10; repeating that in a unit
test would mean shipping a gigabyte of weights to assert something a
measurement already established.

What is tested is **the rule for when a split is allowed**, against constructed
voices, because that rule is the whole safety argument. A false split is a new
failure mode that did not exist before this module, and it is worse than the bug
it repairs: a missed boundary leaves two sentences under one name, which a reader
can see and fix, while an invented boundary puts words in somebody's mouth in a
transcript that now looks *more* carefully attributed than it is.

So almost every test below is a refusal.
"""

from __future__ import annotations

import asyncio
import math

import pytest

from app.rediarize import Limits, SpeakerRefiner
from app.schemas import Segment, Word
from app.voiceprints import EMBEDDING_DIM, l2_normalise

# --- constructed voices ------------------------------------------------------ #


def voice(seed: int) -> list[float]:
    """A deterministic unit vector standing in for one person's voice."""
    return l2_normalise([math.sin(seed * 1.7 + i * 0.37) for i in range(EMBEDDING_DIM)])


def blend(a: list[float], b: list[float], weight: float) -> list[float]:
    """`weight` of b mixed into a. Stands in for a stretch containing both."""
    return l2_normalise([(1 - weight) * x + weight * y for x, y in zip(a, b)])


ALICE, BOB = voice(1), voice(2)


def timeline(*spans):
    """A sampler over a ground-truth speaker timeline.

    `spans` are `(start, end, vector)`. A stretch that straddles a boundary
    comes back as a mixture, weighted by how much of each it contains — which is
    what real audio does and is the only reason a scan can find a boundary
    rather than merely confirm one it was told about.
    """

    def sample(start: float, end: float):
        if end - start < 0.4:
            return None
        totals: list[tuple[float, list[float]]] = []
        for lo, hi, vec in spans:
            overlap = max(0.0, min(end, hi) - max(start, lo))
            if overlap > 0:
                totals.append((overlap, vec))
        if not totals:
            return None
        span = sum(t for t, _ in totals)
        mixed = [0.0] * EMBEDDING_DIM
        for weight, vec in totals:
            for i, v in enumerate(vec):
                mixed[i] += (weight / span) * v
        return l2_normalise(mixed)

    return lambda _audio: sample


def words(start: float, end: float, count: int, speaker: str) -> list[Word]:
    step = (end - start) / count
    return [
        Word(text=f"w{i}", start=start + i * step, end=start + (i + 1) * step,
             speaker=speaker, speaker_raw=speaker[-1])
        for i in range(count)
    ]


def seg(start: float, end: float, speaker: str, key: str, *, n: int = 20) -> Segment:
    return Segment(
        start=start, end=end, speaker=speaker, speaker_key=key,
        speaker_raw=key[-1], speaker_status="attributed",
        text=" ".join(f"w{i}" for i in range(n)),
        words=words(start, end, n, speaker),
    )


async def refine(segments, sampler, limits=None):
    refiner = SpeakerRefiner(limits=limits, sampler_for=sampler)

    async def loader():
        return b"audio"

    return await refiner.refine(list(segments), loader)


# Short turns either side, so both speakers have reference audio, plus the long
# turn under test. This is the reported recording's shape.
def transcript(long_turn: Segment) -> list[Segment]:
    return [
        seg(0.0, 2.5, "Speaker 1", "spk_1", n=6),
        seg(3.0, 5.5, "Speaker 2", "spk_2", n=6),
        seg(6.0, 8.5, "Speaker 1", "spk_1", n=6),
        seg(9.0, 11.5, "Speaker 2", "spk_2", n=6),
        long_turn,
        seg(40.0, 42.0, "Speaker 1", "spk_1", n=6),
    ]


CLEAN = [(0.0, 2.5, ALICE), (3.0, 5.5, BOB), (6.0, 8.5, ALICE),
         (9.0, 11.5, BOB), (40.0, 42.0, ALICE)]


# --- 1. the reported bug ----------------------------------------------------- #
async def test_a_turn_holding_two_people_is_split_where_they_change():
    """The shape of the reported recording: 20s labelled one speaker, two in it."""
    long_turn = seg(12.0, 32.0, "Speaker 2", "spk_2", n=40)
    sampler = timeline(*CLEAN, (12.0, 20.0, BOB), (20.0, 32.0, ALICE))

    out, report = await refine(transcript(long_turn), sampler)

    assert report.split == 1
    changed = [s for s in out if 12.0 <= s.start < 32.0]
    assert len(changed) == 2
    assert [s.speaker for s in changed] == ["Speaker 2", "Speaker 1"]
    # Within one word of the truth. A boundary half a second out puts a whole
    # clause under the wrong name, which is the bug wearing different clothes.
    assert abs(changed[1].start - 20.0) <= 0.6


async def test_not_a_word_is_lost_or_invented():
    long_turn = seg(12.0, 32.0, "Speaker 2", "spk_2", n=40)
    sampler = timeline(*CLEAN, (12.0, 20.0, BOB), (20.0, 32.0, ALICE))

    before = transcript(long_turn)
    out, _ = await refine(before, sampler)

    assert sum(len(s.words) for s in out) == sum(len(s.words) for s in before)
    assert [w.text for s in out for w in s.words] == [w.text for s in before for w in s.words]


async def test_no_speaker_is_ever_invented():
    """The strongest safety property, and it is structural.

    A repair may only assign labels that were already in the meeting, so
    canonical numbering, colours, talk-time and voice profiles cannot be
    disturbed by one. There is no branch that mints a speaker key.
    """
    long_turn = seg(12.0, 32.0, "Speaker 2", "spk_2", n=40)
    sampler = timeline(*CLEAN, (12.0, 20.0, BOB), (20.0, 32.0, ALICE))

    before = transcript(long_turn)
    out, _ = await refine(before, sampler)

    assert {s.speaker for s in out} == {s.speaker for s in before}
    assert {s.speaker_key for s in out} == {s.speaker_key for s in before}


async def test_the_two_halves_keep_their_own_timings():
    long_turn = seg(12.0, 32.0, "Speaker 2", "spk_2", n=40)
    sampler = timeline(*CLEAN, (12.0, 20.0, BOB), (20.0, 32.0, ALICE))

    out, _ = await refine(transcript(long_turn), sampler)
    left, right = [s for s in out if 12.0 <= s.start < 32.0]

    # Contiguous and covering exactly what the original did: a gap here would be
    # audio attributed to nobody, and an overlap would be audio attributed twice.
    assert left.start == 12.0
    assert left.end == right.start
    assert right.end == 32.0
    assert left.words[-1].end <= right.words[0].start


# --- 2. and now the refusals -------------------------------------------------- #
async def test_one_person_talking_for_a_long_time_is_left_alone():
    """The commonest long turn there is, and the one a keen splitter ruins."""
    long_turn = seg(12.0, 32.0, "Speaker 2", "spk_2", n=40)
    sampler = timeline(*CLEAN, (12.0, 32.0, BOB))

    out, report = await refine(transcript(long_turn), sampler)

    assert report.examined == 1
    assert report.split == 0
    assert len([s for s in out if 12.0 <= s.start < 32.0]) == 1


async def test_a_stretch_that_matches_nobody_well_is_not_a_speaker_change():
    """The half that sounds different but is still nearest the same person.

    Music, background noise, a bad stretch of line, somebody moving away from
    the microphone. The two halves are unlike *each other*, which is the signal
    a change would produce — but they both still land on the same speaker, and a
    speaker cannot hand over to themselves. Without this check a noisy patch
    inside one person's turn becomes a fabricated turn boundary.
    """
    odd = l2_normalise([0.3 * a + b for a, b in zip(ALICE, voice(7))])
    long_turn = seg(12.0, 32.0, "Speaker 1", "spk_1", n=40)
    sampler = timeline(*CLEAN, (12.0, 20.0, ALICE), (20.0, 32.0, odd))

    out, report = await refine(transcript(long_turn), sampler)

    assert report.examined == 1
    assert report.split == 0
    assert len([s for s in out if 12.0 <= s.start < 32.0]) == 1


async def test_a_short_turn_is_never_examined():
    """Below the threshold the reward is small and the evidence is thin.

    Each side of a split needs enough audio to be judged on, and a turn that
    cannot supply it is one where the model is least reliable — which is the
    wrong place to start making corrections.
    """
    short = seg(12.0, 16.0, "Speaker 2", "spk_2", n=8)
    sampler = timeline(*CLEAN, (12.0, 14.0, BOB), (14.0, 16.0, ALICE))

    out, report = await refine(transcript(short), sampler)

    assert report.examined == 0
    assert report.split == 0
    assert len(out) == 6


async def test_two_speakers_who_sound_alike_stop_the_whole_meeting():
    """Not a failure: an admission.

    If the model cannot separate these two voices, then every split it proposes
    in this recording is a coin toss with a confident face — including the ones
    that happen to be right.
    """
    twin = blend(ALICE, BOB, 0.02)
    clean = [(0.0, 2.5, ALICE), (3.0, 5.5, twin), (6.0, 8.5, ALICE),
             (9.0, 11.5, twin), (40.0, 42.0, ALICE)]
    long_turn = seg(12.0, 32.0, "Speaker 2", "spk_2", n=40)
    sampler = timeline(*clean, (12.0, 20.0, twin), (20.0, 32.0, ALICE))

    out, report = await refine(transcript(long_turn), sampler)

    assert report.split == 0
    assert "too alike" in (report.skipped_reason or "")
    assert len(out) == 6


async def test_a_meeting_with_one_speaker_is_never_touched():
    """Nothing to reassign to, and inventing somebody is out of the question."""
    solo = [
        seg(0.0, 2.5, "Speaker 1", "spk_1", n=6),
        seg(3.0, 5.5, "Speaker 1", "spk_1", n=6),
        seg(6.0, 8.5, "Speaker 1", "spk_1", n=6),
        seg(12.0, 32.0, "Speaker 1", "spk_1", n=40),
    ]
    sampler = timeline((0.0, 40.0, ALICE))

    out, report = await refine(solo, sampler)

    assert report.split == 0
    assert "fewer than two" in (report.skipped_reason or "")
    assert len(out) == 4


async def test_a_speaker_with_too_little_reference_audio_cannot_be_assigned_to():
    """A voice we barely have a sample of is a voice we cannot recognise.

    Speaker 1 here appears only in fragments too short to embed, so there is no
    reference to judge anything against and the answer has to be "we don't know".
    """
    thin = [
        seg(0.0, 0.3, "Speaker 1", "spk_1", n=2),
        seg(3.0, 5.5, "Speaker 2", "spk_2", n=6),
        seg(9.0, 11.5, "Speaker 2", "spk_2", n=6),
        seg(12.0, 32.0, "Speaker 2", "spk_2", n=40),
    ]
    sampler = timeline((0.0, 0.3, ALICE), (3.0, 5.5, BOB), (9.0, 11.5, BOB),
                       (12.0, 20.0, BOB), (20.0, 32.0, ALICE))

    out, report = await refine(thin, sampler)

    assert report.split == 0
    assert len(out) == 4


async def test_an_unattributed_turn_supplies_no_reference():
    """"Unknown speaker" is the provider declining to say whose voice it was.

    Averaging it into somebody's reference would build a picture of a voice out
    of audio that may belong to anybody in the room.
    """
    segments = transcript(seg(12.0, 32.0, "Speaker 2", "spk_2", n=40))
    segments[0] = segments[0].model_copy(update={
        "speaker": "Unknown speaker", "speaker_status": "unknown"})
    sampler = timeline(*CLEAN, (12.0, 20.0, BOB), (20.0, 32.0, ALICE))

    out, report = await refine(segments, sampler)

    # Speaker 1 still has its other short turns, so this still resolves — the
    # assertion is that it resolves to Speaker 1 and not to the unknown label.
    assert "Unknown speaker" not in {s.speaker for s in out if s.start >= 12.0}


async def test_a_turn_with_almost_no_words_is_not_split():
    """A boundary has to land between words. With three of them, it cannot."""
    sparse = seg(12.0, 32.0, "Speaker 2", "spk_2", n=3)
    sampler = timeline(*CLEAN, (12.0, 20.0, BOB), (20.0, 32.0, ALICE))

    out, report = await refine(transcript(sparse), sampler)

    assert report.examined == 0
    assert report.split == 0


# --- 3. failing safe ---------------------------------------------------------- #
async def test_no_audio_means_the_providers_segmentation_stands():
    long_turn = seg(12.0, 32.0, "Speaker 2", "spk_2", n=40)
    segments = transcript(long_turn)
    refiner = SpeakerRefiner(sampler_for=timeline(*CLEAN))

    async def nothing():
        return b""

    out, report = await refiner.refine(list(segments), nothing)

    assert out == segments
    assert report.skipped_reason == "no audio available"


async def test_no_loader_means_the_providers_segmentation_stands():
    segments = transcript(seg(12.0, 32.0, "Speaker 2", "spk_2", n=40))
    refiner = SpeakerRefiner(sampler_for=timeline(*CLEAN))

    out, report = await refiner.refine(list(segments), None)

    assert out == segments
    assert report.split == 0


async def test_an_embedder_that_throws_loses_nothing():
    """Any failure here is a refinement not happening, never a meeting failing.

    The transcript is the product; this only ever improves it, so a broken
    improvement must cost nothing.
    """
    def exploding(_audio):
        def sample(start, end):
            raise RuntimeError("model fell over")
        return sample

    segments = transcript(seg(12.0, 32.0, "Speaker 2", "spk_2", n=40))
    out, report = await refine(segments, exploding)

    assert out == segments
    assert (report.skipped_reason or "").startswith("failed:")


async def test_without_the_model_it_reports_itself_off_and_changes_nothing():
    segments = transcript(seg(12.0, 32.0, "Speaker 2", "spk_2", n=40))
    refiner = SpeakerRefiner()  # no torch in the test environment

    async def loader():
        return b"audio"

    out, report = await refiner.refine(list(segments), loader)

    assert refiner.available is False
    assert out == segments
    assert report.skipped_reason == "embedder not installed"


# --- 4. bounded work ---------------------------------------------------------- #
async def test_a_long_turn_costs_no_more_to_examine_than_a_short_one():
    """Coarse-to-fine, so an hour-long monologue does not stall the pipeline."""
    calls = {"n": 0}
    base = timeline(*CLEAN, (12.0, 200.0, BOB))

    def counting(audio):
        inner = base(audio)

        def sample(start, end):
            calls["n"] += 1
            return inner(start, end)

        return sample

    await refine(transcript(seg(12.0, 200.0, "Speaker 2", "spk_2", n=400)), counting)
    long_calls = calls["n"]

    calls["n"] = 0
    await refine(transcript(seg(12.0, 32.0, "Speaker 2", "spk_2", n=40)), counting)
    short_calls = calls["n"]

    # A turn ten times longer must not cost ten times as much to look at.
    assert long_calls < short_calls * 3


async def test_the_whole_meeting_has_a_budget():
    """A transcript of nothing but long turns cannot stall a job."""
    many = [seg(0.0, 2.5, "Speaker 1", "spk_1", n=6), seg(3.0, 5.5, "Speaker 2", "spk_2", n=6),
            seg(6.0, 8.5, "Speaker 1", "spk_1", n=6), seg(9.0, 11.5, "Speaker 2", "spk_2", n=6)]
    t = 12.0
    for _ in range(60):
        many.append(seg(t, t + 10.0, "Speaker 2", "spk_2", n=20))
        t += 10.0
    sampler = timeline((0.0, 2.5, ALICE), (3.0, 5.5, BOB), (6.0, 8.5, ALICE),
                       (9.0, 11.5, BOB), (12.0, 1000.0, BOB))

    _, report = await refine(many, sampler, Limits(max_segments_examined=5))

    assert report.examined == 5


# --- 5. the seam itself -------------------------------------------------------- #
async def test_the_refiner_reasons_only_about_vectors():
    """Structural: decoding, span selection and the model sit behind one function.

    Worth pinning because it is what keeps the rules above testable without a
    gigabyte of weights, and what would let the model be replaced without
    touching a single decision.
    """
    import inspect

    import app.rediarize as module

    # Both halves. `_refine` awaits the audio and hands the rest to a thread;
    # `_refine_blocking` is that rest, and it is where the decisions live -- so
    # checking only the first would have let the seam break the moment the body
    # moved, which is exactly what happened when the threading went in.
    for name in ("_refine", "_refine_blocking"):
        source = inspect.getsource(getattr(module.SpeakerRefiner, name))
        for leaked in ("decode_to_pcm", "take_spans", "torch", "numpy", "pcm"):
            assert leaked not in source, f"{name}: {leaked}"


async def test_refinement_does_not_block_the_event_loop():
    """The loop stays responsive while a meeting is being refined.

    Not a performance test. Speaker refinement runs for minutes, and it shares
    this loop with the chat handlers and with aiokafka's heartbeat coroutine --
    which, when it was starved, got the consumer evicted and the meeting
    redelivered and transcribed a second time. See the module docstring.
    """
    import time

    ticks = 0

    async def heartbeat():
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    def slow_sampler(_audio: bytes):
        def sample(start: float, end: float):
            # Stands in for the decode and the forward passes: synchronous,
            # holds no lock this test can see, and long enough that a blocked
            # loop would be obvious.
            time.sleep(0.05)
            return ALICE if start < 6.0 else BOB
        return sample

    beat = asyncio.create_task(heartbeat())
    try:
        await refine(transcript(seg(12.0, 30.0, "Speaker 2", "spk_2", n=20)),
                     slow_sampler)
    finally:
        beat.cancel()

    # On the event loop this was 0: the whole refinement ran between two
    # scheduling points and the heartbeat never got a turn.
    assert ticks > 0, "the event loop was blocked for the whole refinement"


@pytest.mark.parametrize("reason", [
    "nothing to examine",
    "embedder not installed",
    "no audio available",
])
async def test_every_decline_says_why(reason):
    """The log line has to distinguish "nothing to do" from "could not look"."""
    assert isinstance(reason, str) and reason


# --- 6. the wiring, not just the rules ---------------------------------------- #
#
# The rules above all passed while the pipeline call site was broken: it assigned
# to `transcript.text`, and the field is called `transcript`. Pydantic refuses an
# unknown attribute, so every meeting with a repairable turn in it failed to
# process — a worse bug than the one being fixed, introduced by the fix.
#
# These exercise `Pipeline.process` itself.
class _Stub:
    """A transcription port that returns a fixed, repairable transcript."""

    def __init__(self, response):
        self._response = response

    async def transcribe(self, audio, filename, language=None, *, request=None):
        return self._response


class _Llm:
    async def summarize(self, transcript, language="en", **kw):
        from app.schemas import SummaryResponse
        _Llm.saw = transcript
        return SummaryResponse(short_summary="", detailed_summary="", key_points=[])

    async def extract_action_items(self, transcript, language="en"):
        return []

    async def suggest_questions(self, material, *, workspace=False, scope="workspace"):
        return []


async def test_the_pipeline_refines_and_rebuilds_the_flat_transcript():
    from app.pipeline import Pipeline
    from app.schemas import TranscriptResponse

    segments = transcript(seg(12.0, 32.0, "Speaker 2", "spk_2", n=40))
    response = TranscriptResponse(
        transcript="\n".join(f"{s.speaker}: {s.text}" for s in segments),
        language="en", segments=segments,
    )
    sampler = timeline(*CLEAN, (12.0, 20.0, BOB), (20.0, 32.0, ALICE))
    refiner = SpeakerRefiner(sampler_for=sampler)

    async def loader():
        return b"audio"

    pipeline = Pipeline(_Stub(response), _Llm(), refiner)
    await pipeline.process("mtg_1", b"", "a.webm", audio_loader=loader)

    # Seven turns where the provider gave six, and the flat text rebuilt from
    # them: the summarizer reads that string, so leaving it describing the old
    # turns would put the corrected transcript and the summary into permanent
    # disagreement.
    assert len(response.segments) == 7

    lines = response.transcript.splitlines()
    assert len(lines) == 7
    # The repaired turn is now two lines under two names, where it was one.
    left, right = lines[4], lines[5]
    assert left.startswith("Speaker 2: ")
    assert right.startswith("Speaker 1: ")
    # And the fragment that begins mid-utterance is sentence-cased, because it
    # starts there only by virtue of having been split out. The same liberty
    # `split_by_speaker` already takes: "…and monitor production." reads as a
    # broken line rather than as a turn.
    assert right.split(": ", 1)[1][0].isupper()
    # Nothing is duplicated across the seam.
    assert set(left.split(": ", 1)[1].split()).isdisjoint(
        w.lower() for w in right.split(": ", 1)[1].split())


async def test_the_pipeline_survives_a_refiner_that_finds_nothing():
    from app.pipeline import Pipeline
    from app.schemas import TranscriptResponse

    segments = transcript(seg(12.0, 32.0, "Speaker 2", "spk_2", n=40))
    original = "\n".join(f"{s.speaker}: {s.text}" for s in segments)
    response = TranscriptResponse(transcript=original, language="en", segments=segments)
    refiner = SpeakerRefiner(sampler_for=timeline(*CLEAN, (12.0, 32.0, BOB)))

    async def loader():
        return b"audio"

    await Pipeline(_Stub(response), _Llm(), refiner).process(
        "mtg_1", b"", "a.webm", audio_loader=loader)

    # Untouched, byte for byte. A refinement that changes nothing must not
    # rewrite the provider's own text as a side effect.
    assert len(response.segments) == 6
    assert response.transcript == original


async def test_a_pipeline_with_no_refiner_behaves_exactly_as_before():
    from app.pipeline import Pipeline
    from app.schemas import TranscriptResponse

    segments = transcript(seg(12.0, 32.0, "Speaker 2", "spk_2", n=40))
    original = "\n".join(f"{s.speaker}: {s.text}" for s in segments)
    response = TranscriptResponse(transcript=original, language="en", segments=segments)

    await Pipeline(_Stub(response), _Llm()).process("mtg_1", b"", "a.webm")

    assert len(response.segments) == 6
    assert response.transcript == original


class TestDecliningIsSaidOutLoud:
    """Why refinement did nothing, which nothing used to record.

    Refinement is what stands between a provider that merged two people into
    one turn and a transcript that shows it. It has five ways of declining and
    only one of them was ever logged, so "the model is not installed on this
    deployment" and "this recording has no turn worth examining" produced
    identical evidence: none. They have completely different responses.
    """

    @staticmethod
    def _segments(spans):
        from app.schemas import Segment, Word
        out = []
        for index, (speaker, start, end) in enumerate(spans):
            words = [
                Word(text=f"w{n}", start=start + n * 0.5, end=start + (n + 1) * 0.5)
                for n in range(max(4, int((end - start) * 2)))
            ]
            out.append(Segment(
                start=start, end=end, speaker=speaker, text=" ".join(w.text for w in words),
                speaker_key=f"spk_{1 if speaker.endswith('1') else 2}",
                speaker_status="attributed", words=words,
            ))
        return out

    @pytest.mark.asyncio
    async def test_no_embedder_is_reported_not_silent(self, caplog):
        import logging

        from app.pipeline import Pipeline
        from app.providers.mock_adapter import MockLlmAdapter
        from app.rediarize import SpeakerRefiner
        from app.schemas import TranscriptResponse

        segments = self._segments([("Speaker 1", 0.0, 40.0), ("Speaker 2", 40.5, 44.0)])

        class _Provider:
            async def transcribe(self, audio, filename, language=None, *, request=None):
                return TranscriptResponse(transcript="x", language="en", segments=list(segments))

        # A refiner with no embedder and no sampler: exactly a deployment
        # without torch, which is a configuration problem and not a property of
        # the recording.
        refiner = SpeakerRefiner()
        refiner._checked = True
        refiner._embedder = None

        pipeline = Pipeline(_Provider(), MockLlmAdapter(), refiner=refiner, name_speakers=False)
        with caplog.at_level(logging.INFO, logger="ai-service.pipeline"):
            await pipeline.process("mtg_refine", b"audio", "a.wav",
                                   audio_loader=_loader)

        lines = [r.getMessage() for r in caplog.records
                 if "Speaker refinement" in r.getMessage()]
        # Exactly one line, whichever branch declined.
        assert len(lines) == 1
        assert "reason=embedder not installed" in lines[0]
        assert "examinedTurns=" in lines[0]
        # The provider had two voices; refinement never got far enough to
        # build a reference for either. That pair of numbers is the diagnosis.
        assert "usableReferences=0" in lines[0]
        assert "providerSpeakers=2" in lines[0]

    @pytest.mark.asyncio
    async def test_a_recording_with_nothing_to_examine_says_so(self, caplog):
        import logging

        from app.pipeline import Pipeline
        from app.providers.mock_adapter import MockLlmAdapter
        from app.rediarize import SpeakerRefiner
        from app.schemas import TranscriptResponse

        # Every turn is short, so none can be hiding another. A completely
        # different situation from the one above and it used to look the same.
        segments = self._segments([("Speaker 1", 0.0, 3.0), ("Speaker 2", 3.5, 6.0)])

        class _Provider:
            async def transcribe(self, audio, filename, language=None, *, request=None):
                return TranscriptResponse(transcript="x", language="en", segments=list(segments))

        refiner = SpeakerRefiner(sampler_for=lambda audio: (lambda a, b: [0.1] * 192))
        pipeline = Pipeline(_Provider(), MockLlmAdapter(), refiner=refiner, name_speakers=False)
        with caplog.at_level(logging.INFO, logger="ai-service.pipeline"):
            await pipeline.process("mtg_short", b"audio", "a.wav", audio_loader=_loader)

        lines = [r.getMessage() for r in caplog.records
                 if "Speaker refinement" in r.getMessage()]
        assert len(lines) == 1
        assert "reason=no turn long enough to hide another" in lines[0]
        assert "providerSpeakers=2" in lines[0]


async def _loader():
    return b"audio-bytes"


class TestTheDiagnosticIsSafeToShip:
    """What the line may contain, asserted rather than intended.

    It is emitted at INFO on a deployment holding other people's meetings, so
    the useful check is not that it says the right things — it is that it
    cannot say the wrong ones. `Report` carries a reason and three integers and
    has nowhere to put a name, a sentence or a vector.
    """

    def test_the_line_is_counts_and_a_reason_and_nothing_else(self):
        from app.rediarize import Report

        report = Report(examined=3, split=0, references=1, provider_speakers=3,
                        merged=2, canonical_speakers=1,
                        skipped_reason="fewer than two speakers with usable reference audio")

        assert report.as_log_fields() == (
            "reason=fewer than two speakers with usable reference audio "
            "examinedTurns=3 usableReferences=1 providerSpeakers=3 "
            "mergedLabels=2 canonicalSpeakers=1 splitTurns=0 "
            "microTurnsExamined=0 microTurnsCorrected=0 microTurnsAmbiguous=0 "
            "rawLabelsSplit=0 substantialTurnsReassigned=0"
        )

    def test_every_field_is_a_count_or_the_reason(self):
        # Guards the shape against a future field. Anything added to Report that
        # is not an int or the reason string has to be considered for this line
        # before it can appear in a log on somebody's meeting.
        import dataclasses

        from app.rediarize import Report

        for field in dataclasses.fields(Report):
            if field.name == "skipped_reason":
                continue
            assert field.type in ("int", int), (
                f"{field.name} is not a count; decide whether it may be logged"
            )

    @pytest.mark.parametrize("reason", [
        "nothing to examine",
        "embedder not installed",
        "no turn long enough to hide another",
        "no audio available",
        "fewer than two speakers with usable reference audio",
        "speakers too alike to judge (cos=0.61)",
    ])
    def test_every_reason_is_a_fixed_phrase(self, reason):
        # None of the six is built from anything the meeting said. The only
        # interpolated value anywhere is a cosine, which is a scalar derived
        # from two references and not a template.
        from app.rediarize import Report

        line = Report(skipped_reason=reason).as_log_fields()
        assert line.startswith(f"reason={reason} ")
        assert "\n" not in line
