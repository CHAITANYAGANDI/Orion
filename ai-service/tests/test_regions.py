"""Region-level reconciliation: what it corrects, and what it refuses to.

`app.regions` decides who is in a meeting from the audio, with the provider's
labels as a prior rather than a constraint. It can do three things a label-space
rule could not:

* fold two labels that are one voice, on repeated evidence rather than one
  cosine between two averages;
* take a single turn away from a label that otherwise belongs to somebody else;
* refuse to number a voice the meeting never actually heard.

Most of this file is the refusals, because the expensive mistakes are all in
that direction. A refused correction leaves a transcript a reader can see is
wrong and fix with one rename. A wrong one puts words in somebody's mouth and
leaves nothing behind to notice it by.
"""

from __future__ import annotations

import pytest

from app.regions import Cluster, Region, one_voice, reconcile, separated
from app.rediarize import Limits, SpeakerRefiner
from app.voiceprints import cosine
from tests.meeting_fixture import nearby, voice

ALICE, BOB, CAROL = voice(1), voice(2), voice(3)
#: Two participants this model renders similarly, which is the case that makes
#: merging dangerous and the reason a fixture of orthogonal voices proves little.
TWIN = nearby(BOB, voice(4), 0.35)

LIMITS = Limits()


def region(index, start, seconds, speaks, *, windows=None):
    """One turn's worth of evidence, as the refiner would have embedded it.

    The sample count follows `_reference_windows`: a turn short enough to trust
    whole contributes one window, a longer one up to three from its interior.
    It matters because a label heard only once has no spread *between* regions,
    and those windows are the only thing it can be calibrated against.
    """
    if windows is None:
        windows = max(1, min(3, int(seconds // 6)))
    return Region(index=index, start=start, end=start + seconds,
                  seconds=seconds, vector=speaks, samples=[speaks] * windows)


def meeting(plan):
    """`plan` is `[(provider_label, seconds, voice)]`, laid end to end."""
    priors: dict[str, list[Region]] = {}
    at = 0.0
    for index, (label, seconds, speaks) in enumerate(plan):
        priors.setdefault(label, []).append(region(index, at, seconds, speaks))
        at += seconds + 0.5
    return priors


def owner(outcome, priors, index):
    """The canonical key one segment ends up under."""
    if index in outcome.moved:
        return outcome.moved[index]
    for label, regions in priors.items():
        if any(r.index == index for r in regions):
            return outcome.mapping[label]
    raise AssertionError(f"no region for segment {index}")


class TestOverDiarization:
    """One voice, several provider labels — the opening-alternation bug."""

    #: The production shape: labels A and B alternate for the whole meeting and
    #: are the same person; C is somebody else.
    ALTERNATING = [
        ("A", 14.0, ALICE), ("B", 7.0, ALICE), ("A", 6.0, ALICE),
        ("B", 40.0, ALICE), ("C", 20.0, BOB), ("A", 41.0, ALICE),
        ("B", 11.0, ALICE),
    ]

    def test_the_alternating_labels_become_one_voice(self):
        priors = meeting(self.ALTERNATING)

        outcome = reconcile(priors, LIMITS)

        assert outcome.merged == 1
        assert outcome.mapping["A"] == outcome.mapping["B"]
        assert outcome.mapping["C"] != outcome.mapping["A"]

    def test_the_other_participant_is_untouched(self):
        priors = meeting(self.ALTERNATING)

        outcome = reconcile(priors, LIMITS)

        assert len({outcome.mapping[label] for label in "ABC"}) == 2

    def test_a_merge_reaches_a_label_that_only_spoke_once(self):
        # Repeated evidence is required *for the meeting*, not from every label.
        # A label with one turn cannot supply two comparisons on its own, and
        # gets folded in through a label that can — which is exactly how a
        # provider that split one voice five ways gets undone.
        priors = meeting([
            ("A", 20.0, ALICE), ("B", 20.0, BOB), ("C", 20.0, ALICE),
            ("A", 18.0, ALICE), ("B", 18.0, BOB),
        ])

        outcome = reconcile(priors, LIMITS)

        assert outcome.mapping["C"] == outcome.mapping["A"]

    def test_two_labels_that_each_spoke_once_are_left_alone(self):
        # One region against one region is a single cosine, which is the claim
        # this module exists to refuse to act on.
        priors = meeting([("A", 20.0, ALICE), ("B", 20.0, ALICE)])

        outcome = reconcile(priors, LIMITS)

        assert outcome.merged == 0


class TestTheMergeRefuses:
    """Every one of these is a way of being wrong, and each has been."""

    def test_two_similar_people_stay_two_people(self):
        priors = meeting([
            ("A", 20.0, BOB), ("B", 20.0, TWIN),
            ("A", 18.0, BOB), ("B", 18.0, TWIN),
        ])

        outcome = reconcile(priors, LIMITS)

        assert outcome.merged == 0
        assert outcome.mapping["A"] != outcome.mapping["B"]

    def test_a_doubtful_pair_no_longer_stops_the_whole_meeting(self):
        # The change this release makes to the merge, and the reason the opening
        # alternation survived two of them. C and D are borderline against each
        # other; A and B are unequivocally one voice. Doubt is now resolved
        # where it occurs.
        near = nearby(CAROL, ALICE, 0.30)
        priors = meeting([
            ("A", 20.0, ALICE), ("B", 20.0, ALICE), ("C", 20.0, CAROL),
            ("D", 20.0, near), ("A", 18.0, ALICE), ("B", 18.0, ALICE),
            ("C", 18.0, CAROL), ("D", 18.0, near),
        ])

        outcome = reconcile(priors, LIMITS)

        assert outcome.mapping["A"] == outcome.mapping["B"]
        assert outcome.mapping["C"] != outcome.mapping["D"]

    def test_a_label_holding_two_voices_is_never_merged_with_anybody(self):
        # Its reference is an average of two people, and an average of two
        # people can resemble a third convincingly.
        priors = meeting([
            ("A", 20.0, ALICE), ("A", 20.0, BOB), ("A", 20.0, BOB),
            ("B", 20.0, ALICE), ("B", 18.0, ALICE),
        ])

        outcome = reconcile(priors, LIMITS)

        assert outcome.heterogeneous == 1
        assert outcome.merged == 0

    def test_five_genuinely_different_voices_stay_five(self):
        priors = meeting([
            ("A", 20.0, ALICE), ("B", 20.0, BOB), ("C", 20.0, CAROL),
            ("D", 20.0, voice(7)), ("E", 20.0, voice(8)),
            ("A", 18.0, ALICE), ("B", 18.0, BOB), ("C", 18.0, CAROL),
            ("D", 18.0, voice(7)), ("E", 18.0, voice(8)),
        ])

        outcome = reconcile(priors, LIMITS)

        assert outcome.merged == 0
        assert len({outcome.mapping[label] for label in "ABCDE"}) == 5


class TestRegionReassignment:
    """One turn taken off a label that otherwise belongs to somebody else."""

    #: Label B is Bob's, except for one four-second turn Alice said.
    POISONED = [
        ("A", 20.0, ALICE), ("B", 4.0, ALICE), ("A", 20.0, ALICE),
        ("B", 30.0, BOB), ("B", 25.0, BOB), ("B", 20.0, BOB),
    ]

    def test_the_foreign_turn_goes_to_the_person_who_said_it(self):
        priors = meeting(self.POISONED)

        outcome = reconcile(priors, LIMITS)

        assert outcome.reassigned == 1
        assert owner(outcome, priors, 1) == outcome.mapping["A"]

    def test_the_rest_of_the_label_is_undisturbed(self):
        priors = meeting(self.POISONED)

        outcome = reconcile(priors, LIMITS)

        assert {owner(outcome, priors, i) for i in (3, 4, 5)} == {outcome.mapping["B"]}

    def test_nobody_is_created_to_hold_it(self):
        priors = meeting(self.POISONED)

        outcome = reconcile(priors, LIMITS)

        assert outcome.split == 0
        assert len(set(outcome.mapping.values())) == 2

    def test_a_turn_matching_nobody_stays_where_the_provider_put_it(self):
        # The safety property that makes reassignment different from splitting:
        # a region that no existing voice claims goes home rather than founding
        # a person on evidence nobody corroborated.
        priors = meeting([
            ("A", 20.0, ALICE), ("A", 20.0, ALICE), ("A", 20.0, CAROL),
            ("B", 20.0, BOB), ("B", 18.0, BOB),
        ])

        outcome = reconcile(priors, LIMITS)

        assert outcome.reassigned == 0
        assert outcome.would_split == 1
        assert owner(outcome, priors, 2) == outcome.mapping["A"]

    def test_a_short_region_is_never_moved(self):
        # Well above the embedder's own floor. A fragment identified from a
        # second of audio is the shape of every regression this module has
        # caused.
        priors = meeting([
            ("A", 20.0, ALICE), ("A", 20.0, ALICE), ("A", 1.2, BOB),
            ("B", 20.0, BOB), ("B", 18.0, BOB),
        ])

        outcome = reconcile(priors, LIMITS)

        assert outcome.reassigned == 0

    def test_a_turn_that_is_not_one_voice_is_left_for_the_boundary_search(self):
        # A long turn whose own windows disagree may hold two people, and giving
        # the whole of it to one speaker would settle by fiat a question the
        # split search is about to answer properly.
        mixed = Region(index=2, start=45.0, end=65.0, seconds=9.0,
                       vector=BOB, samples=[ALICE, BOB, BOB])
        priors = meeting([
            ("A", 20.0, ALICE), ("A", 20.0, ALICE),
            ("B", 20.0, BOB), ("B", 18.0, BOB),
        ])
        priors["A"].append(mixed)

        outcome = reconcile(priors, LIMITS)

        assert outcome.reassigned == 0
        assert 2 not in outcome.moved


class TestNumbering:
    """`Speaker N` by first stable appearance, not by first appearance."""

    def test_a_voice_with_real_audio_is_numbered_before_a_thin_one(self):
        # `B` speaks first, but only ever in fragments the embedder refused, so
        # it produced no regions at all. It used to take Speaker 1 and push
        # everybody along behind it.
        priors = {
            "B": [],
            "A": [region(1, 5.0, 20.0, ALICE), region(3, 60.0, 20.0, ALICE)],
        }

        outcome = reconcile(priors, LIMITS)

        assert outcome.order == ["A"]

    def test_voices_are_ordered_by_when_they_were_first_heard(self):
        priors = meeting([
            ("A", 20.0, ALICE), ("B", 20.0, BOB), ("C", 20.0, CAROL),
            ("A", 18.0, ALICE), ("B", 18.0, BOB), ("C", 18.0, CAROL),
        ])

        outcome = reconcile(priors, LIMITS)

        assert outcome.order == ["A", "B", "C"]

    def test_a_merged_voice_keeps_the_earlier_of_its_two_first_appearances(self):
        priors = meeting([
            ("A", 20.0, BOB), ("B", 20.0, ALICE), ("C", 20.0, ALICE),
            ("A", 18.0, BOB), ("B", 18.0, ALICE), ("C", 18.0, ALICE),
        ])

        outcome = reconcile(priors, LIMITS)

        head = outcome.mapping["B"]
        assert outcome.mapping["C"] == head
        assert outcome.clusters[head].first_at == 20.5


class TestSeparation:
    """The one definition of 'this label disagrees with itself'."""

    def test_a_label_holding_two_people_separates(self):
        regions = [region(0, 0.0, 20.0, ALICE), region(1, 25.0, 20.0, BOB),
                   region(2, 50.0, 20.0, BOB)]

        split = separated(regions, LIMITS)

        assert split is not None
        assert len(split[0]) == 2 and len(split[1]) == 1

    @pytest.mark.parametrize("drift", [0.05, 0.10, 0.15])
    def test_a_voice_that_merely_varies_does_not(self, drift):
        # Conditions change across a meeting: somebody moves, a headset is
        # adjusted. Varying is not separating.
        later = nearby(ALICE, BOB, drift)
        regions = [region(0, 0.0, 20.0, ALICE), region(1, 25.0, 20.0, ALICE),
                   region(2, 50.0, 20.0, later)]

        assert separated(regions, LIMITS) is None

    def test_the_majority_is_by_turns_and_not_by_seconds(self):
        # A twenty-second turn that really does hold two people contributes far
        # more sampled audio than the two clean short turns beside it. Counting
        # seconds, it wins the vote and the label keeps the wrong voice.
        regions = [region(0, 0.0, 2.5, ALICE), region(1, 5.0, 2.5, ALICE),
                   region(2, 10.0, 9.0, BOB)]

        keep, drop = separated(regions, LIMITS)

        assert [r.index for r in keep] == [0, 1]
        assert [r.index for r in drop] == [2]

    def test_one_region_cannot_disagree_with_itself(self):
        assert separated([region(0, 0.0, 20.0, ALICE)], LIMITS) is None


class TestTheLabelSplitStaysOff:
    """Kept working, kept disabled — so re-enabling it is a switch."""

    #: One label used by two people, neither of whom is anywhere else.
    REUSED = [
        ("A", 24.0, ALICE), ("B", 24.0, BOB), ("C", 24.0, CAROL),
        ("D", 24.0, voice(7)), ("A", 24.0, ALICE), ("B", 24.0, BOB),
        ("D", 24.0, voice(8)), ("A", 24.0, ALICE),
    ]

    def test_it_is_seen_and_not_acted_on(self):
        outcome = reconcile(meeting(self.REUSED), LIMITS)

        assert outcome.would_split == 1
        assert outcome.split == 0
        assert outcome.reassigned == 0

    def test_the_capability_still_works_when_switched_on(self):
        priors = meeting(self.REUSED)

        outcome = reconcile(priors, Limits(split_labels_enabled=True))

        assert outcome.split == 1
        assert owner(outcome, priors, 3) != owner(outcome, priors, 6)

    def test_the_second_voice_is_numbered_after_the_people_already_heard(self):
        priors = meeting(self.REUSED)

        outcome = reconcile(priors, Limits(split_labels_enabled=True))

        assert outcome.order[-1] == owner(outcome, priors, 6)


class TestTheTrace:
    """The §2 trace: enough to settle whose mistake a wrong speaker is.

    It is the answer to a question nothing else can reach — *did the provider
    alternate, or did Reverie?* — and it has to be answerable on a deployment
    holding other people's meetings, which means it may not carry one word of
    what anybody said.
    """

    @staticmethod
    async def emit(caplog):
        import logging

        from tests.golden_opening_meeting import build

        segments, sampler, _ = build()
        refiner = SpeakerRefiner(sampler_for=sampler)
        refiner._trace_enabled = True

        async def loader():
            return b"audio"

        with caplog.at_level(logging.INFO, logger="ai-service.rediarize"):
            await refiner.refine(segments, loader)
        return [record.getMessage() for record in caplog.records]

    async def test_every_region_is_reported_with_its_prior_and_its_verdict(self, caplog):
        lines = [line for line in await self.emit(caplog) if " region " in line]

        assert lines
        for field in ("at=", "seconds=", "providerLabel=", "wordLabels=",
                      "priorSpeaker=", "labelConsistency=", "nearest=",
                      "similarity=", "finalSpeaker="):
            assert all(field in line for line in lines)

    async def test_the_provider_s_own_alternation_is_visible(self, caplog):
        # The §2 question, and the one the rendered transcript cannot answer:
        # two labels folded into one speaker still show two provider ordinals,
        # so a reader can tell whether the provider alternated or Reverie did.
        lines = [line for line in await self.emit(caplog) if " region " in line]

        main = [line for line in lines if "finalSpeaker=1" in line]
        labels = {line.split("providerLabel=")[1].split(" ")[0] for line in main}
        assert len(labels) > 1

    async def test_the_turns_that_moved_say_so(self, caplog):
        lines = [line for line in await self.emit(caplog) if " region " in line]

        moved = [line for line in lines
                 if "priorSpeaker=1 " in line and "finalSpeaker=1" not in line]
        assert not moved, "the main speaker's own regions should not move"
        assert any("priorSpeaker=" in line and "finalSpeaker=1" in line
                   and "priorSpeaker=1" not in line for line in lines), (
            "the cadence turn moved onto the main speaker and should be visible")

    async def test_it_carries_no_word_of_the_meeting(self, caplog):
        from tests.golden_opening_meeting import TIMELINE

        lines = await self.emit(caplog)

        for _start, _seconds, label, _voice, human, note in TIMELINE:
            for secret in (human, note):
                assert not secret or secret not in "\n".join(lines)
        # Nor the provider's own tokens, which can be a real name where the
        # provider ran speaker identification rather than clustering.
        assert not any(f"raw={label}" in line for line in lines for label in "ABCDEF")

    async def test_it_is_silent_unless_somebody_turned_it_on(self, caplog):
        import logging

        from tests.golden_opening_meeting import build

        segments, sampler, _ = build()
        refiner = SpeakerRefiner(sampler_for=sampler)
        refiner._trace_enabled = False

        async def loader():
            return b"audio"

        with caplog.at_level(logging.INFO, logger="ai-service.rediarize"):
            await refiner.refine(segments, loader)

        assert not [r for r in caplog.records if "reconciliation" in r.getMessage()]


class TestOneVoiceInIsolation:
    """The merge rule, stated one refusal at a time."""

    @staticmethod
    def cluster(name, *vectors):
        return Cluster(
            key=name,
            regions=[region(i, i * 25.0, 20.0, vec) for i, vec in enumerate(vectors)],
        )

    def refuse(self, a, b, score, extra=None):
        clusters = {"A": a, "B": b}
        clusters.update(extra or {})
        return one_voice(a, b, score, clusters, list(clusters), LIMITS,
                         lambda *args, **fields: None)

    def test_agreement_is_judged_against_each_label_s_own_spread(self):
        varied = nearby(ALICE, BOB, 0.2)

        # Each label's own regions only agree at ~0.97, so agreeing with each
        # other at 0.99 is better than either manages alone: one voice, twice.
        loose = (self.cluster("A", ALICE, varied), self.cluster("B", ALICE, varied))
        assert self.refuse(*loose, 0.99) is True

        # Both are internally perfect, so 0.99 is a real gap: two people this
        # model renders very similarly, and nothing may be concluded.
        tight = (self.cluster("A", ALICE, ALICE), self.cluster("B", BOB, BOB))
        assert self.refuse(*tight, 0.99) is False

    def test_a_third_voice_nearly_as_close_blocks_the_merge(self):
        varied = nearby(ALICE, CAROL, 0.45)
        rival = self.cluster("C", nearby(ALICE, CAROL, 0.25), ALICE)

        assert self.refuse(self.cluster("A", ALICE, varied),
                           self.cluster("B", ALICE, varied),
                           0.90, {"C": rival}) is False

    def test_a_duplicate_third_label_does_not_protect_them_from_each_other(self):
        # A provider that split one voice five ways produces labels that are all
        # nearly identical. Counting each as competition would make every
        # duplicate shelter every other one.
        varied = nearby(ALICE, BOB, 0.2)
        clone = self.cluster("C", ALICE, varied)

        assert self.refuse(self.cluster("A", ALICE, varied),
                           self.cluster("B", ALICE, varied),
                           0.99, {"C": clone}) is True

    def test_one_odd_region_does_not_refuse_a_merge_the_rest_support(self):
        # Unanimity across every region pair is too strict once a label has six
        # of them: a cough or a laugh refuses a merge thirty-five comparisons
        # support. What makes the supermajority safe is that a label genuinely
        # holding two voices has had the minority withheld before this is asked.
        a = self.cluster("A", ALICE, ALICE, ALICE, nearby(ALICE, CAROL, 0.4))
        b = self.cluster("B", ALICE, ALICE, ALICE)

        assert self.refuse(a, b, cosine(a.vector, b.vector)) is True

    def test_a_label_with_no_measurable_spread_is_never_merged(self):
        # One region, and one window inside it, so there is nothing to ask "do
        # they agree better than either agrees with itself?" against. An
        # uncalibrated merge is the guess this rule exists to avoid.
        alone = Cluster(key="A", regions=[region(0, 0.0, 20.0, ALICE, windows=1)])

        assert self.refuse(alone, self.cluster("B", ALICE, ALICE), 0.99) is False
