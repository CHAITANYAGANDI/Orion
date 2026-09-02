"""The provider's *other* failure: too many labels, not too few.

`test_rediarize.py` is about a turn holding two people. This file is about the
mirror image, which production produced:

    AssemblyAI returned 7 segment(s) across 5 speaker(s)
    Provider labels ['A', 'B', 'C', 'D', 'E']

    Speaker refinement made no change:
      reason=fewer than two speakers with usable reference audio
      examinedTurns=0  usableReferences=0  providerSpeakers=5

Two people were in the room. The provider split them across five labels — and
Reverie could not correct any of it, because **every turn was longer than the
whole-turn reference cutoff**, so every turn was excluded from reference
building and there was nothing left to compare anything against.

Two fixes, tested here. References are now gathered from window interiors as
well as short turns, so a meeting of long turns has evidence at all. And with
evidence, labels that are one voice can be folded onto one canonical speaker.

The second is the dangerous one, so most of this file is refusals. A wrong
merge puts two people under one name and leaves nothing in the transcript to
notice it by — strictly worse than the over-diarization it was trying to fix,
which at least shows a reader that something is off.
"""

from __future__ import annotations

import pytest

from app.rediarize import Reference, SpeakerRefiner
from tests.test_rediarize import (
    ALICE,
    BOB,
    blend,
    refine,
    seg,
    timeline,
    voice,
)

CAROL, DAVE, ERIN = voice(3), voice(4), voice(5)


def long_meeting(plan, *, length: float = 21.0, gap: float = 0.5):
    """A meeting of long turns: `plan` is `[(provider_label, voice)]`.

    Every turn is far longer than `reference_to_seconds`, which is the shape
    that produced `usableReferences=0`. Canonical labels are numbered by first
    appearance, exactly as `parse_response` numbers them.
    """
    order: dict[str, int] = {}
    segments, spans = [], []
    at = 0.0
    for label, vec in plan:
        if label not in order:
            order[label] = len(order) + 1
        number = order[label]
        segment = seg(at, at + length, f"Speaker {number}", f"spk_{number}", n=40)
        segment.speaker_raw = label
        for word in segment.words:
            word.speaker_raw = label
        segments.append(segment)
        spans.append((at, at + length, vec))
        at += length + gap
    return segments, timeline(*spans)


#: The observed shape. A, C and E are one person; B and D are another.
PRODUCTION = [
    ("A", ALICE), ("B", BOB), ("C", ALICE),
    ("D", BOB), ("E", ALICE), ("A", ALICE), ("B", BOB),
]


class TestTheProductionFailure:
    """The reported meeting, and what the fix does to it."""

    def test_the_fixture_reproduces_the_shape_that_broke(self):
        # Guards the fixture itself. If any turn here were short enough for the
        # old rule to accept, this file would prove nothing at all.
        segments, _ = long_meeting(PRODUCTION)
        assert len(segments) == 7
        assert len({s.speaker_raw for s in segments}) == 5
        assert all(s.end - s.start > 6.0 for s in segments)

    async def test_references_are_built_where_there_used_to_be_none(self):
        segments, sampler = long_meeting(PRODUCTION)
        refiner = SpeakerRefiner(sampler_for=sampler)

        references = refiner._references(segments, sampler(b"audio"))

        # Five, where the old whole-turn rule produced zero.
        assert len(references) == 5
        assert set(references) == {f"Speaker {i}" for i in range(1, 6)}
        assert all(references[name].consistency > 0 for name in references)

    async def test_the_five_labels_collapse_onto_the_two_real_voices(self):
        segments, sampler = long_meeting(PRODUCTION)

        out, report = await refine(segments, sampler)

        assert report.references == 5
        assert report.provider_speakers == 5
        assert report.merged == 3
        assert report.canonical_speakers == 2
        assert {s.speaker for s in out} == {"Speaker 1", "Speaker 2"}

    async def test_the_provider_label_on_every_turn_is_untouched(self):
        segments, sampler = long_meeting(PRODUCTION)

        out, _ = await refine(segments, sampler)

        assert [s.speaker_raw for s in out] == ["A", "B", "C", "D", "E", "A", "B"]

    async def test_canonical_identity_follows_the_voice_not_the_label(self):
        segments, sampler = long_meeting(PRODUCTION)

        out, _ = await refine(segments, sampler)

        by_raw = {s.speaker_raw: s.speaker_key for s in out}
        assert by_raw["A"] == by_raw["C"] == by_raw["E"]
        assert by_raw["B"] == by_raw["D"]
        assert by_raw["A"] != by_raw["B"]
        # Numbered by first appearance, as an unmerged meeting is.
        assert [s.speaker_key for s in out] == [
            "spk_1", "spk_2", "spk_1", "spk_2", "spk_1", "spk_1", "spk_2",
        ]

    async def test_words_follow_their_turn_and_keep_the_provider_token(self):
        segments, sampler = long_meeting(PRODUCTION)

        out, _ = await refine(segments, sampler)

        third = out[2]                              # provider C, now Speaker 1
        assert third.speaker == "Speaker 1"
        assert {w.speaker for w in third.words} == {"Speaker 1"}
        assert {w.speaker_raw for w in third.words} == {"C"}

    async def test_timings_and_order_are_not_disturbed(self):
        segments, sampler = long_meeting(PRODUCTION)
        before = [(s.start, s.end, s.text) for s in segments]

        out, _ = await refine(segments, sampler)

        assert [(s.start, s.end, s.text) for s in out] == before


class TestWhatMustNeverHappen:
    """Every one of these is a refusal, and each is a way of being wrong."""

    async def test_one_genuine_speaker_never_becomes_two(self):
        segments, sampler = long_meeting([("A", ALICE), ("A", ALICE), ("A", ALICE)])

        out, report = await refine(segments, sampler)

        assert {s.speaker for s in out} == {"Speaker 1"}
        assert report.split == 0

    async def test_two_clearly_different_speakers_remain_two(self):
        segments, sampler = long_meeting(
            [("A", ALICE), ("B", BOB), ("A", ALICE), ("B", BOB)])

        out, report = await refine(segments, sampler)

        assert report.merged == 0
        assert {s.speaker for s in out} == {"Speaker 1", "Speaker 2"}

    async def test_five_genuinely_different_voices_stay_five(self):
        # The case that makes merging dangerous. Five labels and five people is
        # indistinguishable from five labels and two people by label count
        # alone, which is why the count is never consulted.
        segments, sampler = long_meeting([
            ("A", ALICE), ("B", BOB), ("C", CAROL), ("D", DAVE), ("E", ERIN),
        ])

        out, report = await refine(segments, sampler)

        assert report.provider_speakers == 5
        assert report.merged == 0
        assert report.canonical_speakers == 5
        assert {s.speaker for s in out} == {f"Speaker {i}" for i in range(1, 6)}
        assert [s.speaker_raw for s in out] == ["A", "B", "C", "D", "E"]

    @pytest.mark.parametrize("closeness", [0.30, 0.20, 0.12])
    async def test_voices_that_are_merely_similar_are_left_alone(self, closeness):
        # Inside the maybe-band, or short of it. One ambiguous pair abandons
        # merging for the whole meeting rather than merging the pairs beside it.
        near = blend(ALICE, BOB, closeness)
        segments, sampler = long_meeting(
            [("A", ALICE), ("B", near), ("A", ALICE), ("B", near)])

        out, report = await refine(segments, sampler)

        assert report.merged == 0
        assert {s.speaker for s in out} == {"Speaker 1", "Speaker 2"}

    @staticmethod
    def _reference(*vectors):
        return Reference(vector=vectors[0],
                         windows=[((i * 3.0, i * 3.0 + 3.0), v)
                                  for i, v in enumerate(vectors)])

    def test_a_label_with_no_measurable_spread_is_never_merged(self):
        # A single window has no spread, so "do they agree better than either
        # agrees with itself?" cannot be asked -- and an uncalibrated merge is
        # exactly the guess this rule exists to avoid.
        refiner = SpeakerRefiner()
        refs = {"A": self._reference(ALICE), "B": self._reference(ALICE, ALICE)}

        assert refiner._one_voice("A", "B", 0.99, refs, ["A", "B"]) is False

    def test_agreement_is_judged_against_each_label_s_own_spread(self):
        refiner = SpeakerRefiner()
        varied = blend(ALICE, BOB, 0.2)          # about 0.97 against ALICE

        # Each label's own windows only agree at ~0.97, so agreeing with each
        # other at 0.99 is better than either manages alone: one voice, twice.
        loose = {"A": self._reference(ALICE, varied), "B": self._reference(ALICE, varied)}
        assert refiner._one_voice("A", "B", 0.99, loose, ["A", "B"]) is True

        # Both are internally perfect, so 0.99 is a real gap: two people this
        # model renders very similarly, and nothing may be concluded.
        tight = {"A": self._reference(ALICE, ALICE), "B": self._reference(BOB, BOB)}
        assert refiner._one_voice("A", "B", 0.99, tight, ["A", "B"]) is False

    def test_a_third_voice_nearly_as_close_blocks_the_merge(self):
        # One cosine between two averages is not meeting-wide evidence. Where
        # some other established voice is almost as close, these references are
        # not telling people apart at all.
        refiner = SpeakerRefiner()
        varied = blend(ALICE, BOB, 0.2)
        refs = {
            "A": self._reference(ALICE, varied),
            "B": self._reference(ALICE, varied),
            "C": self._reference(ALICE, varied),
        }
        # C is identical to both, so it is a duplicate rather than a rival and
        # must not protect them from being recognised.
        assert refiner._one_voice("A", "B", 0.99, refs, ["A", "B", "C"]) is True

    async def test_an_unattributed_turn_is_not_given_a_voice(self):
        segments, sampler = long_meeting([("A", ALICE), ("B", BOB), ("A", ALICE)])
        segments[1].speaker_status = "unknown"
        segments[1].speaker = "Unknown speaker"
        segments[1].speaker_key = None

        out, _ = await refine(segments, sampler)

        assert out[1].speaker == "Unknown speaker"
        assert out[1].speaker_key is None

    async def test_no_embedder_leaves_the_provider_alone(self):
        segments, _ = long_meeting(PRODUCTION)
        before = [(s.speaker, s.speaker_key, s.speaker_raw) for s in segments]
        refiner = SpeakerRefiner()
        refiner._checked, refiner._embedder = True, None

        async def loader():
            return b"audio"

        out, report = await refiner.refine(list(segments), loader)

        assert [(s.speaker, s.speaker_key, s.speaker_raw) for s in out] == before
        assert report.skipped_reason == "embedder not installed"
        assert report.provider_speakers == 5

    async def test_audio_that_cannot_be_embedded_declines(self):
        segments, _ = long_meeting(PRODUCTION)
        before = [s.speaker for s in segments]

        out, report = await refine(segments, lambda _audio: (lambda a, b: None))

        assert report.merged == 0
        assert report.split == 0
        assert [s.speaker for s in out] == before

    async def test_a_short_interjection_is_not_reassigned_on_thin_audio(self):
        # One word between two long turns. There is not enough of it to say
        # whose it is, and the provider's answer stands.
        segments, sampler = long_meeting([("A", ALICE), ("B", BOB)])
        tiny = seg(45.0, 45.6, "Speaker 3", "spk_3", n=2)
        tiny.speaker_raw = "C"
        segments.append(tiny)

        out, report = await refine(segments, sampler)

        assert out[-1].speaker_raw == "C"
        assert report.split == 0
