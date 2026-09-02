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
from tests.meeting_fixture import correct


async def run(limits=None):
    segments, sampler, expected = build()
    refiner = SpeakerRefiner(limits=limits, sampler_for=sampler)

    async def loader():
        return b"audio"

    out, report = await refiner.refine(segments, loader)
    return out, report, expected




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

    async def test_no_two_labels_are_folded_together(self):
        # Five voices, five labels, and no two of them one person. Nothing here
        # is over-diarized, so a merge would be a mistake.
        _, report, _ = await run()

        assert report.merged == 0

    async def test_the_extra_person_under_label_d_is_separated_out(self):
        # Five provider labels, six people: label D carries Speaker 4 early and
        # Speaker 5 nine minutes later, and human verification says they are
        # different. The turn at 09:32 resembles nobody already in the meeting,
        # which is the evidence that it is somebody new rather than a turn
        # somebody else's label mislaid.
        out, report, _ = await run()

        assert report.provider_speakers == 5
        assert report.labels_split == 1
        assert len({s.speaker_key for s in out}) == 6

        early = next(s for s in out if s.start == mm("2:04"))
        late = next(s for s in out if s.start == mm("9:32"))
        assert early.speaker != late.speaker
        assert early.speaker_raw == late.speaker_raw == "D"

    async def test_islands_are_only_corrected_between_matching_neighbours(self):
        _, report, _ = await run()

        # Five examined; the two with the same speaker either side corrected,
        # the rest preserved rather than guessed at.
        assert report.islands_examined == 5
        assert report.islands_corrected == 2
        assert report.islands_ambiguous == 1

    async def test_only_the_one_label_that_holds_two_people_is_split(self):
        # Four other labels are each one voice, and a split is the one
        # correction here that can invent a person who was never in the room.
        _, report, _ = await run()

        assert report.labels_split == 1
        assert report.heterogeneous_labels == 2

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
        assert report.substantial_reassigned == 2      # the cadence turn, and 09:32

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
        # The comparative acceptance rule, pinned. Both shipped builds group 23
        # of these 26 regions correctly; region reconciliation reaches 25, and
        # neither number is a target -- 23 is the floor a change may not fall
        # below, and 25 is the ratchet so that a later change cannot quietly
        # give this back.
        out, _, expected = await run()

        assert correct(out, expected) >= 25

    async def test_the_diagnostic_says_what_happened_without_saying_what_was_said(self):
        _, report, _ = await run()

        line = report.as_log_fields()
        for field in ("microTurnsExamined", "microTurnsCorrected", "rawLabelsWouldSplit"):
            assert field in line
        for row in TIMELINE:
            assert row[5] not in line or row[5] == ""
