"""The launch-planning meeting, as a standing regression guard.

Four reported errors, three mechanisms, and two of them are cases this module
refused to correct for two releases:

    [02:01]  "Yeah, same."   under Speaker 1, said by Speaker 4
    [02:27]  the cadence line, under Brian, said by the main speaker
    [08:51]  "But I--"       under Speaker 1, said by Brian
    [09:32]  a 48s turn      under Speaker 4, said by somebody who is
                             nowhere else in the meeting

The cadence line is the longest-running error in this investigation, reported
against three separate recordings. It and [09:32] are the same shape from the
provider's side -- one label holding two voices -- and they need opposite
corrections, which is why they are the pair worth keeping together: the cadence
turn belongs to somebody already in the room and is *moved*, and the 09:32 turn
belongs to nobody in it and is the one case where a speaker gets created.

Both shipped builds get all four wrong, and for one reason that has nothing to
do with any of them: two participants in this meeting sound alike, and the
"speakers too alike to judge" gate took the *worst*-separated pair and declined
the whole recording. `microTurnsExamined=0`. Nothing was ever looked at.

So most of what this file pins is not a new rule. It is what the rules that
already existed do once they are allowed to run.
"""

from __future__ import annotations

import pytest

from app.rediarize import Limits, SpeakerRefiner
from tests.golden_named_meeting import TIMELINE, build, mm
from tests.meeting_fixture import correct

#: What both shipped builds scored: 26 of 30 regions.
SHIPPED_SCORE = 26


async def run(limits=None):
    segments, sampler, expected = build()
    refiner = SpeakerRefiner(limits=limits, sampler_for=sampler)

    async def loader():
        return b"audio"

    out, report = await refiner.refine(segments, loader)
    return out, report, expected


def at(out, time: str):
    return next(segment for segment in out if segment.start == mm(time))


class TestTheMeetingIsExaminedAtAll:
    """The reason all four errors survived: nothing ran."""

    async def test_two_similar_participants_no_longer_silence_the_meeting(self):
        _, report, _ = await run()

        assert report.skipped_reason is None
        assert report.islands_examined > 0

    async def test_the_two_who_sound_alike_are_still_not_merged(self):
        # What made the old gate fire is real: Speaker 3 and Cindy score 0.83
        # against each other. They are two people, and staying two is the whole
        # point of refusing rather than declining.
        out, report, _ = await run()

        assert report.merge_ambiguous == 1
        assert report.merged == 0
        assert at(out, "1:55").speaker != at(out, "1:12").speaker


class TestTheMisfiledTurns:

    async def test_the_two_second_turn_goes_to_the_speaker_who_said_it(self):
        # [02:01] "Yeah, same." -- long enough for the embedder to answer, so it
        # is decided on its own sound rather than on which turns surround it.
        out, _, _ = await run()

        assert at(out, "2:01").speaker == at(out, "2:03").speaker

    async def test_the_cadence_turn_goes_to_the_speaker_who_said_it(self):
        # [02:27] -- eight seconds under Brian's label that the main speaker
        # said. The oldest error in this investigation, and the one a label-space
        # rule could never reach: Brian is a real participant with three other
        # turns, so nothing about his *label* is wrong.
        out, _, _ = await run()

        assert at(out, "2:27").speaker == at(out, "2:17").speaker
        assert at(out, "2:27").speaker == at(out, "0:01").speaker

    async def test_brian_keeps_every_turn_he_actually_spoke(self):
        # The other half of the same decision. Correcting the cadence turn by
        # taking the label off him would trade one error for four.
        out, _, _ = await run()

        brian = {at(out, t).speaker for t in ("7:10", "8:52", "10:25")}
        assert len(brian) == 1
        assert brian != {at(out, "0:01").speaker}

    async def test_the_fragment_inside_a_monologue_goes_back_to_it(self):
        # [08:51] "But I--" is six tenths of a second, below the embedder's
        # floor, with the same speaker either side. Nothing can identify it
        # directly; what settles it is that one voice runs through it unbroken.
        out, _, _ = await run()

        assert at(out, "8:51").speaker == at(out, "7:10").speaker
        assert at(out, "8:51").speaker == at(out, "8:52").speaker

    async def test_neither_correction_touches_the_provider_s_own_record(self):
        out, _, _ = await run()

        assert at(out, "2:01").speaker_raw == "A"
        assert at(out, "2:27").speaker_raw == "E"
        assert at(out, "8:51").speaker_raw == "A"


class TestTheSecondVoiceUnderOneLabel:
    """The case that needed a speaker created, reported three times."""

    async def test_the_late_turn_is_not_the_early_speaker(self):
        out, report, _ = await run()

        assert report.labels_split == 1
        assert at(out, "9:32").speaker != at(out, "2:03").speaker
        assert at(out, "9:32").speaker != at(out, "3:02").speaker

    async def test_the_early_turns_keep_their_speaker(self):
        out, _, _ = await run()

        assert at(out, "2:03").speaker == at(out, "3:02").speaker

    async def test_the_new_speaker_is_nobody_already_in_the_meeting(self):
        out, _, _ = await run()

        established = {at(out, t).speaker for t in
                       ("0:01", "1:12", "1:55", "2:03", "7:10")}
        assert at(out, "9:32").speaker not in established

    async def test_both_halves_still_say_the_provider_called_them_d(self):
        out, _, _ = await run()

        assert at(out, "2:03").speaker_raw == "D"
        assert at(out, "9:32").speaker_raw == "D"

    async def test_the_new_speaker_is_numbered_last(self):
        # A voice heard for the first time nine minutes in does not renumber the
        # five people who were already talking.
        out, _, _ = await run()

        assert at(out, "9:32").speaker == "Speaker 6"
        assert at(out, "0:01").speaker == "Speaker 1"

    async def test_the_switch_still_turns_it_off(self):
        out, report, _ = await run(Limits(split_labels_enabled=False))

        assert report.labels_would_split == 1
        assert report.labels_split == 0
        assert at(out, "9:32").speaker == at(out, "2:03").speaker


class TestWhatMustNotRegress:

    async def test_every_other_speaker_is_left_whole(self):
        out, _, expected = await run()

        for person in ("Main", "Cindy", "Speaker 3", "Brian"):
            labels = {segment.speaker for segment, want in zip(out, expected)
                      if want == person}
            assert len(labels) == 1, f"{person} was split across {labels}"

    async def test_no_two_people_share_a_speaker(self):
        out, _, expected = await run()

        people: dict[str, set[str]] = {}
        for segment, want in zip(out, expected):
            people.setdefault(segment.speaker, set()).add(want)
        assert all(len(v) == 1 for v in people.values())

    async def test_timings_and_order_are_never_disturbed(self):
        out, _, _ = await run()

        assert [(s.start, s.end) for s in out] == [
            (row[0], row[0] + row[1]) for row in TIMELINE
        ]

    async def test_provider_provenance_survives_every_correction(self):
        out, _, _ = await run()

        assert [s.speaker_raw for s in out] == [row[2] for row in TIMELINE]

    async def test_the_grouping_is_correct_everywhere(self):
        out, _, expected = await run()

        assert correct(out, expected) > SHIPPED_SCORE
        assert correct(out, expected) == len(expected)
