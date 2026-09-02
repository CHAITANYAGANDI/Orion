"""The opening-alternation meeting, as a standing regression guard.

The acceptance rule is comparative and it is two-sided: **a change must improve
total correctness and must not lose ground either shipped release held.** A fix
for one timestamp that damages two others is a regression however good the fix
is, and the counts here are how that gets checked rather than argued about.

Scored on *grouping*, not on display names. The question is whether the turns
one person said end up together, not whether they end up under the number a
human would have picked — a meeting that merely renumbered has not regressed,
and a meeting that regrouped has, and comparing labels reports both backwards.
"""

from __future__ import annotations

import pytest

from app.rediarize import SpeakerRefiner
from tests.golden_opening_meeting import TIMELINE, build, mm

#: What the two shipped builds scored on this timeline: 23 of 30 regions, with
#: the main speaker split four ways and every interruption fragment filed as
#: somebody else. Not a target -- a floor.
SHIPPED_SCORE = 23


async def run(limits=None):
    segments, sampler, expected = build()
    refiner = SpeakerRefiner(limits=limits, sampler_for=sampler)

    async def loader():
        return b"audio"

    out, report = await refiner.refine(segments, loader)
    return out, report, expected


def grouping(out, expected):
    """Each output label mapped to the person it first speaks for."""
    seen: dict[str, str] = {}
    for segment, want in zip(out, expected):
        seen.setdefault(segment.speaker, want)
    return [seen[segment.speaker] for segment in out]


def at(out, time: str):
    return next(segment for segment in out if segment.start == mm(time))


class TestTheOpeningAlternation:
    """The highest-priority bug: one voice, four turns, two speaker numbers."""

    async def test_the_first_four_turns_are_one_speaker(self):
        out, _, _ = await run()

        assert len({at(out, t).speaker for t in ("0:00", "0:14", "0:21", "0:27")}) == 1

    async def test_the_alternating_labels_are_folded_into_one_voice(self):
        _, report, _ = await run()

        assert report.merged == 1

    async def test_the_whole_meeting_agrees_about_the_main_speaker(self):
        # Not merely the opening. The same two labels alternate for eleven
        # minutes, and merging them at 00:14 while leaving 10:37 behind would
        # move the bug rather than fix it.
        #
        # Over the turns there is evidence about, which is every one the
        # embedder will answer for. The sub-second fragments are a separate
        # question with a separate test, and folding them in here would hide
        # which of the two failed.
        out, _, expected = await run()

        main = {
            segment.speaker
            for segment, want in zip(out, expected)
            if want == "Main" and segment.end - segment.start >= 1.0
        }
        assert len(main) == 1

    async def test_both_provider_labels_are_still_on_their_turns(self):
        out, _, _ = await run()

        assert at(out, "0:00").speaker_raw == "A"
        assert at(out, "0:14").speaker_raw == "B"


class TestTheInterruptionFragments:
    """Four one-second turns the provider gave to people who were not talking."""

    @pytest.mark.parametrize("time", ["4:26", "5:45", "6:18"])
    async def test_a_fragment_goes_back_to_the_speaker_it_interrupted(self, time):
        out, _, _ = await run()

        assert at(out, time).speaker == at(out, "0:00").speaker

    async def test_the_one_between_two_different_speakers_is_left_alone(self):
        # [10:32] "And that--" is seven tenths of a second, which is below the
        # embedder's floor, and its neighbours are two different people. There
        # is no acoustic evidence about it and no continuous reading to test
        # against, so the only argument for moving it is that it sits between
        # two turns -- and adjacency alone is what caused three production
        # regressions and was rolled back.
        #
        # This is an accepted miss, pinned so that a future change to it is a
        # decision rather than an accident.
        out, _, _ = await run()

        assert at(out, "10:32").speaker != at(out, "10:37").speaker

    async def test_a_fragment_never_carries_somebody_s_name(self):
        # It keeps its identity, because overruling the provider on silence is
        # not better than believing it. What it loses is the standing to have a
        # real person's name attached by transcript inference.
        out, _, _ = await run()

        assert at(out, "10:32").speaker_provisional is True


class TestTheCadenceTurn:
    """One label holding two voices, corrected without inventing anybody."""

    async def test_the_cadence_turn_moves_to_the_main_speaker(self):
        out, report, _ = await run()

        assert at(out, "2:24").speaker == at(out, "0:00").speaker
        assert report.substantial_reassigned == 1

    async def test_the_rest_of_that_label_stays_where_it_was(self):
        out, _, _ = await run()

        brian = {at(out, t).speaker for t in ("2:31", "7:03", "10:19")}
        assert len(brian) == 1
        assert brian != {at(out, "0:00").speaker}

    async def test_nobody_is_invented_to_hold_it(self):
        _, report, _ = await run()

        assert report.labels_split == 0
        assert report.canonical_speakers == 5


class TestWhatMustNotRegress:

    async def test_speaker_five_at_nine_twenty_eight_stays_speaker_five(self):
        # Human-verified correct in the deployed build, and the explicit
        # regression gate in the brief. Its label is close to Speaker 4's in the
        # embedding space, so folding the two is the easiest way to score well
        # everywhere else and be wrong here.
        out, _, _ = await run()

        assert at(out, "9:28").speaker == at(out, "1:58").speaker
        assert at(out, "9:28").speaker != at(out, "1:55").speaker

    async def test_the_two_similar_participants_are_not_merged(self):
        out, _, _ = await run()

        assert at(out, "1:55").speaker != at(out, "1:58").speaker

    async def test_sydney_is_never_confused_with_the_main_speaker(self):
        out, _, _ = await run()

        sydney = {at(out, t).speaker for t in ("1:08", "3:59", "5:46", "6:40")}
        assert len(sydney) == 1
        assert sydney != {at(out, "0:00").speaker}

    async def test_timings_and_order_are_never_disturbed(self):
        out, _, _ = await run()

        assert [(s.start, s.end) for s in out] == [
            (row[0], row[0] + row[1]) for row in TIMELINE
        ]

    async def test_provider_provenance_survives_every_correction(self):
        out, _, _ = await run()

        assert [s.speaker_raw for s in out] == [row[2] for row in TIMELINE]


class TestTheScore:

    async def test_correctness_improves_on_both_shipped_builds(self):
        out, _, expected = await run()

        correct = sum(1 for a, b in zip(grouping(out, expected), expected) if a == b)
        assert correct > SHIPPED_SCORE
        assert correct >= 29

    async def test_one_person_is_not_spread_over_several_speakers(self):
        # False splits, counted. Both shipped builds scored three or four here,
        # all of them the main speaker.
        out, _, expected = await run()

        people: dict[str, set[str]] = {}
        for segment, want in zip(out, expected):
            people.setdefault(want, set()).add(segment.speaker)
        assert sum(len(labels) - 1 for labels in people.values()) <= 1

    async def test_two_people_are_not_collapsed_into_one_speaker(self):
        # False merges, counted -- the expensive direction. A rename undoes an
        # extra speaker; nothing undoes a merge.
        out, _, expected = await run()

        labels: dict[str, set[str]] = {}
        for segment, want in zip(out, expected):
            labels.setdefault(segment.speaker, set()).add(want)
        assert sum(len(people) - 1 for people in labels.values()) <= 1

    async def test_the_diagnostic_says_what_happened_without_saying_what_was_said(self):
        _, report, _ = await run()

        line = report.as_log_fields()
        for field in ("regions", "regionsWithheld", "mergeAmbiguousPairs",
                      "mergedLabels", "substantialTurnsReassigned"):
            assert field in line
        for row in TIMELINE:
            assert row[5] not in line or row[5] == ""
