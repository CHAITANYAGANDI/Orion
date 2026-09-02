"""The golden production meeting, as a standing regression guard.

Built after a release that passed every synthetic micro-test and made the real
transcript worse. Synthetic shapes prove a rule does what it says; only a
production-shaped timeline shows what the rules do to each other.

The acceptance rule is comparative, not absolute: **a change must not lose
ground the previous release held.** A fix for one timestamp that damages two
others is a regression however good the fix is, and the counts below are how
that is checked rather than argued about.
"""

from __future__ import annotations

import pytest

from app.rediarize import Limits, SpeakerRefiner
from tests.golden_production_meeting import TIMELINE, build, stamp


async def run(limits=None):
    segments, sampler, expected = build()
    refiner = SpeakerRefiner(limits=limits, sampler_for=sampler)

    async def loader():
        return b"audio"

    out, report = await refiner.refine(segments, loader)
    return out, report, expected


def grouping(out, expected):
    """Each label mapped to the person it first speaks for. Label-agnostic."""
    seen: dict[str, str] = {}
    for segment, want in zip(out, expected):
        seen.setdefault(segment.speaker, want)
    return [seen[segment.speaker] for segment in out]


class TestTheGoldenMeeting:

    async def test_no_leading_fragment_is_pulled_onto_the_speaker_before_it(self):
        # The three production regressions all had this shape: the first
        # fragment of a legitimate turn reassigned backwards, splitting one
        # correct turn into two wrong ones.
        out, _, _ = await run()

        by_time = {round(s.start, 1): s for s in out}
        # 2:02 opens a Speaker 4 turn that continues at 2:04.
        assert by_time[122.0].speaker == by_time[124.0].speaker
        # 3:04 opens a Speaker 1 turn that continues at 3:06.
        assert by_time[184.0].speaker == by_time[186.0].speaker

    async def test_provider_provenance_survives_every_correction(self):
        out, _, _ = await run()

        assert [s.speaker_raw for s in out] == [row[2] for row in TIMELINE]

    async def test_no_label_is_split_and_none_is_merged(self):
        # Both label-level mechanisms are off or unproven here. The meeting is
        # corrected by micro-turn ownership alone, which is the conservative
        # floor this release rolled back to.
        _, report, _ = await run()

        assert report.labels_split == 0
        assert report.merged == 0

    async def test_the_speaker_count_is_the_provider_s(self):
        # Nothing invented and nobody deleted. Five provider labels in, five
        # canonical speakers out.
        out, report, _ = await run()

        assert report.provider_speakers == 5
        assert len({s.speaker_key for s in out}) == 5

    async def test_islands_are_only_corrected_between_matching_neighbours(self):
        _, report, _ = await run()

        # Five examined; the two with the same speaker either side corrected,
        # the rest preserved rather than guessed at.
        assert report.islands_examined == 5
        assert report.islands_corrected == 2
        assert report.islands_ambiguous == 1

    async def test_the_within_label_split_is_observed_and_not_applied(self):
        _, report, _ = await run()

        assert report.labels_split == 0
        assert report.substantial_reassigned == 0

    async def test_timings_and_order_are_never_disturbed(self):
        out, _, _ = await run()

        assert [(s.start, s.end) for s in out] == [
            (row[0], row[0] + row[1]) for row in TIMELINE
        ]

    async def test_the_grouping_matches_what_the_previous_release_achieved(self):
        # The comparative acceptance rule, pinned. 13 of 26 regions grouped
        # correctly is not a good score and is not meant to read as one -- it is
        # the floor the last production-validated release held, and the number
        # this release is not allowed to fall below.
        out, _, expected = await run()

        correct = sum(1 for a, b in zip(grouping(out, expected), expected) if a == b)
        assert correct >= 13

    async def test_the_diagnostic_says_what_happened_without_saying_what_was_said(self):
        _, report, _ = await run()

        line = report.as_log_fields()
        for field in ("microTurnsExamined", "microTurnsCorrected", "rawLabelsWouldSplit"):
            assert field in line
        for row in TIMELINE:
            assert row[5] not in line or row[5] == ""
