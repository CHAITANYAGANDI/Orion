"""What a speaker's reference is built from, and what it must not be built from.

Every later decision in this module is a margin between two similarities, so a
reference that describes the wrong person does not degrade gracefully — it
quietly makes the answer wrong everywhere at once.

The rule this file replaced took short turns *exclusively* whenever they reached
the floor, and only looked at long ones when they did not. Being short makes a
turn trustworthy, and the rule treated it as making a turn sufficient. In a real
meeting one provider label held 157 seconds across seven turns; eleven of them
were short, so **146 seconds were never looked at** — and four of the eleven were
a turn the provider had attributed to the wrong person. A third of that
speaker's whole reference was somebody else's voice, with a minute and a half of
their own sitting unread.

So evidence is now gathered per *region* — one turn, one vote, whatever its
length — and aggregated robustly across regions. A long turn is better evidence
than a short one and is not fifteen independent observations of it.
"""

from __future__ import annotations

import pytest

from app.rediarize import Limits, SpeakerRefiner
from app.voiceprints import cosine
from tests.test_rediarize import ALICE, BOB, blend, seg, timeline, voice

CAROL = voice(3)


def meeting(plan):
    """`plan` is `[(provider_label, seconds, voice)]`, laid end to end."""
    order: dict[str, int] = {}
    segments, spans = [], []
    at = 0.0
    for label, seconds, vec in plan:
        if label not in order:
            order[label] = len(order) + 1
        number = order[label]
        segment = seg(at, at + seconds, f"Speaker {number}", f"spk_{number}",
                      n=max(4, int(seconds * 2)))
        segment.speaker_raw = label
        segments.append(segment)
        spans.append((at, at + seconds, vec))
        at += seconds + 0.5
    return segments, timeline(*spans)


def references(plan, limits=None):
    segments, sampler = meeting(plan)
    refiner = SpeakerRefiner(limits=limits, sampler_for=sampler)
    return refiner._references(segments, sampler(b"audio"))


def closest(reference, **voices):
    """Which of the named voices this reference actually resembles."""
    return max(voices.items(), key=lambda kv: cosine(reference.vector, kv[1]))[0]


class TestPoisonedReferences:
    """A. One wrongly-labelled short turn must not define a speaker."""

    #: Label B: a four-second turn the provider got wrong, and sixty seconds of
    #: the real speaker afterwards. The old rule saw only the four seconds.
    POISONED = [
        ("A", 20.0, ALICE),
        ("B", 4.0, ALICE),        # <- mislabelled: this is A's voice
        ("A", 20.0, ALICE),
        ("B", 30.0, BOB),
        ("B", 20.0, BOB),
        ("B", 15.0, BOB),
    ]

    def test_the_short_wrong_turn_no_longer_defines_the_speaker(self):
        built = references(self.POISONED)

        assert closest(built["Speaker 2"], alice=ALICE, bob=BOB) == "bob"

    def test_the_substantial_regions_are_actually_sampled(self):
        # The failure was one of *selection*, not of availability: the good
        # audio was there all along and was never read.
        built = references(self.POISONED)

        assert len(built["Speaker 2"].windows) == 4

    def test_the_label_is_flagged_as_disagreeing_with_itself(self):
        built = references(self.POISONED)

        assert built["Speaker 2"].heterogeneous is True

    def test_a_heterogeneous_label_is_not_merged_with_anybody(self):
        # Its reference is an average of two people, and an average of two
        # people can resemble a third convincingly.
        built = references(self.POISONED)
        refiner = SpeakerRefiner()

        assert refiner._one_voice(
            "Speaker 1", "Speaker 2", 0.99, built, list(built)) is False


class TestWhenThereIsOnlyOneTurn:
    """B. Do not require several turns from somebody who only spoke once."""

    def test_a_single_short_turn_still_makes_a_reference(self):
        built = references([
            ("A", 20.0, ALICE),
            ("B", 4.0, BOB),          # the whole of this person's contribution
            ("A", 20.0, ALICE),
        ])

        assert "Speaker 2" in built
        assert closest(built["Speaker 2"], alice=ALICE, bob=BOB) == "bob"

    def test_a_single_turn_speaker_can_still_be_merged(self):
        # One region gives no spread *between* regions, so consistency falls
        # back to the windows inside that turn. Without that fallback a speaker
        # heard once would be silently unmergeable.
        built = references([
            ("A", 20.0, ALICE),
            ("B", 20.0, BOB),
            ("A", 20.0, ALICE),
        ])

        assert built["Speaker 2"].consistency is not None

    def test_too_little_audio_is_still_refused(self):
        built = references([
            ("A", 20.0, ALICE),
            ("B", 1.0, BOB),          # below the floor, and nothing else
            ("A", 20.0, ALICE),
        ])

        assert "Speaker 2" not in built


class TestTheShapesThatAlreadyWorked:
    """C, D, E. Previously good behaviour, still good."""

    def test_several_short_clean_turns(self):
        built = references([
            ("A", 20.0, ALICE),
            ("B", 2.0, BOB), ("A", 5.0, ALICE), ("B", 2.5, BOB),
            ("A", 5.0, ALICE), ("B", 3.0, BOB),
        ])

        assert closest(built["Speaker 2"], alice=ALICE, bob=BOB) == "bob"
        assert len(built["Speaker 2"].windows) == 3

    def test_a_speaker_with_only_long_turns(self):
        built = references([
            ("A", 40.0, ALICE), ("B", 35.0, BOB), ("A", 30.0, ALICE),
        ])

        assert closest(built["Speaker 2"], alice=ALICE, bob=BOB) == "bob"
        assert built["Speaker 2"].samples, "interior windows should be embedded"

    def test_short_and_long_turns_both_contribute(self):
        built = references([
            ("A", 20.0, ALICE),
            ("B", 3.0, BOB), ("A", 20.0, ALICE), ("B", 40.0, BOB),
        ])

        # Two regions, one from each kind, rather than the short one alone.
        assert len(built["Speaker 2"].windows) == 2


class TestRobustAggregation:
    """F, G. Repeated good evidence outweighs one bad region, either way round."""

    def test_one_bad_short_region_among_good_long_ones(self):
        built = references([
            ("A", 20.0, ALICE),
            ("B", 3.0, ALICE),        # <- wrong voice, short
            ("B", 30.0, BOB), ("B", 25.0, BOB), ("B", 20.0, BOB),
        ])

        assert closest(built["Speaker 2"], alice=ALICE, bob=BOB) == "bob"

    def test_one_bad_long_region_among_good_ones(self):
        built = references([
            ("A", 20.0, ALICE),
            ("B", 25.0, CAROL),       # <- wrong voice, and substantial
            ("B", 30.0, BOB), ("B", 25.0, BOB), ("B", 20.0, BOB),
        ])

        assert closest(built["Speaker 2"], alice=ALICE, bob=BOB, carol=CAROL) == "bob"

    def test_one_long_turn_cannot_outvote_every_other_region(self):
        # The domination guard. Six windows fit inside a ninety-second turn; if
        # each counted separately it would outweigh three whole turns of the
        # person it is supposed to be corroborated by.
        built = references([
            ("A", 20.0, ALICE),
            ("B", 90.0, CAROL),       # <- one wrong region, many windows
            ("B", 20.0, BOB), ("B", 18.0, BOB), ("B", 16.0, BOB),
        ])

        assert len(built["Speaker 2"].windows) == 4      # regions, not windows
        assert closest(built["Speaker 2"], alice=ALICE, bob=BOB, carol=CAROL) == "bob"


class TestHeterogeneity:
    """H. Detected, reported, and acted on only by refusing."""

    HETEROGENEOUS = [
        ("A", 20.0, ALICE),
        ("B", 25.0, BOB), ("B", 20.0, BOB),
        ("A", 20.0, ALICE),
        ("B", 25.0, CAROL), ("B", 20.0, CAROL),    # same label, other person
    ]

    def test_a_label_covering_two_people_is_flagged(self):
        built = references(self.HETEROGENEOUS)

        assert built["Speaker 2"].heterogeneous is True

    def test_a_consistent_label_is_not_flagged(self):
        built = references([
            ("A", 20.0, ALICE),
            ("B", 25.0, BOB), ("B", 20.0, BOB), ("B", 22.0, BOB),
        ])

        assert built["Speaker 2"].heterogeneous is False

    @pytest.mark.parametrize("drift", [0.05, 0.10, 0.15])
    def test_a_voice_that_merely_varies_is_not_flagged(self, drift):
        built = references([
            ("A", 20.0, ALICE),
            ("B", 25.0, BOB), ("B", 20.0, BOB),
            ("B", 25.0, blend(BOB, CAROL, drift)),
        ])

        assert built["Speaker 2"].heterogeneous is False

    def test_a_label_covering_two_people_becomes_two_speakers(self):
        # Detection is not the correction, and for two releases it was all there
        # was. Here the minority under label B is twenty-five seconds of a third
        # voice that resembles nobody else in the meeting, which is what a
        # participant looks like and what a bad stretch of audio does not.
        import asyncio

        segments, sampler = meeting(self.HETEROGENEOUS)
        refiner = SpeakerRefiner(sampler_for=sampler)

        async def loader():
            return b"audio"

        out, report = asyncio.run(refiner.refine(segments, loader))

        assert report.heterogeneous_labels == 1
        assert report.labels_would_split == 1
        assert report.labels_split == 1
        assert len({s.speaker_key for s in out}) == 3
        # Provenance is untouched: both halves still say the provider said B.
        assert {s.speaker_raw for s in out if s.speaker_raw == "B"} == {"B"}
