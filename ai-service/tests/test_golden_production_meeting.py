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
from tests.golden_production_meeting import TIMELINE, build, mm, stamp


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
        # Still off: no provider label is turned into two canonical speakers.
        _, report, _ = await run()

        assert report.labels_split == 0

    async def test_the_cadence_turn_goes_to_the_speaker_who_said_it(self):
        # [02:33] is four seconds the provider filed under Brian's label and the
        # main speaker actually said. It is the case that proved a label can
        # hold two voices, and for two releases it stayed wrong because the only
        # correction available was to split the whole label in two.
        #
        # Region reconciliation reaches it without that: the turn disagrees with
        # every other region under its label, it is long enough to be judged on
        # its own, and one existing speaker claims it clearly -- so it moves to
        # them, and nobody is invented.
        out, report, _ = await run()

        cadence = next(s for s in out if s.start == mm("2:33"))
        opening = next(s for s in out if s.start == mm("1:18"))
        assert cadence.speaker == opening.speaker
        assert report.substantial_reassigned == 1

    async def test_the_reassigned_turn_still_says_who_the_provider_blamed(self):
        out, _, _ = await run()

        cadence = next(s for s in out if s.start == mm("2:33"))
        assert cadence.speaker_raw == "F"

    async def test_a_fragment_below_the_embedder_floor_takes_no_ordinal(self):
        # [01:17] is half a second the provider gave its own label. It used to
        # be the second voice heard, so it took `Speaker 2` and pushed every
        # real participant along behind it -- on evidence the embedder had
        # already refused to produce. Numbering now waits for a voice the
        # meeting can actually hear.
        out, _, _ = await run()

        fragment = next(s for s in out if s.start == mm("1:17"))
        first_real = next(s for s in out if s.start == mm("1:18"))
        assert first_real.speaker == "Speaker 2"
        assert fragment.speaker != "Speaker 2"

    async def test_timings_and_order_are_never_disturbed(self):
        out, _, _ = await run()

        assert [(s.start, s.end) for s in out] == [
            (row[0], row[0] + row[1]) for row in TIMELINE
        ]

    async def test_the_grouping_improves_on_what_the_shipped_releases_achieved(self):
        # The comparative acceptance rule, pinned. Both shipped builds group 13
        # of these 26 regions correctly; region reconciliation reaches 21, and
        # neither number is a target -- 13 is the floor a change may not fall
        # below, and 21 is the ratchet so that a later change cannot quietly
        # give this back.
        out, _, expected = await run()

        correct = sum(1 for a, b in zip(grouping(out, expected), expected) if a == b)
        assert correct >= 21

    async def test_the_diagnostic_says_what_happened_without_saying_what_was_said(self):
        _, report, _ = await run()

        line = report.as_log_fields()
        for field in ("microTurnsExamined", "microTurnsCorrected", "rawLabelsWouldSplit"):
            assert field in line
        for row in TIMELINE:
            assert row[5] not in line or row[5] == ""
