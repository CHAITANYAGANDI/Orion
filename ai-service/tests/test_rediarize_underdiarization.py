"""One provider label covering two people, for the whole meeting.

The third direction the provider gets diarization wrong, and the one the rest of
this module could not reach:

    [02:01]  Speaker 4   Yeah, same. Not in real time, but source feedback...
    [09:32]  Speaker 4   Yeah, and that would help me with the plan stuff...

Human verification says those are two different people. Both turns are
substantial, so this is not a micro-turn island; and both arrived under one
canonical speaker, so the split search cannot see it either — that one argues
about *where* a boundary inside a turn falls, never about whether the set of
speakers is right.

Two ways it could happen, needing opposite fixes:

* the provider reused one raw label for two voices — corrected here, by
  `_split_labels`, which gives one raw label two canonical owners in different
  regions;
* Reverie merged two raw labels that were never one person — a false positive in
  `_merge_labels`, and the reason the merge now demands far more than one cosine
  between two averages.

Both are tested. The asymmetry that governs the second is the point: two labels
left on one person is a rename away, while two people under one name silently
corrupts talk time, action-item attribution, the summary, retrieval and the
export at once. So an uncertain duplicate stays two speakers.
"""

from __future__ import annotations

import pytest

from app.rediarize import SpeakerRefiner
from tests.test_rediarize import ALICE, BOB, blend, refine, seg, timeline, voice

CAROL, DAVE, ERIN = voice(3), voice(4), voice(5)


def meeting(plan, *, length: float = 24.0, gap: float = 0.5):
    """`plan` is `[(provider_label, voice)]`; every turn substantial.

    The label is what the provider claimed and the voice is the acoustic truth,
    so a plan where one label carries two voices *is* the provider reusing a
    label — which is exactly the failure under test.
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


def keys(segments):
    return [s.speaker_key for s in segments]


def raws(segments):
    return [s.speaker_raw for s in segments]


class TestOneLabelTwoPeople:
    """Brief fixture C: raw D at t1 is person 4, raw D at t2 is person 5."""

    #: A, B and C are themselves. D is used by two different people, far apart.
    REUSED = [
        ("A", ALICE), ("B", BOB), ("C", CAROL),
        ("D", DAVE),                      # <- person 4, early
        ("A", ALICE), ("B", BOB),
        ("D", ERIN),                      # <- person 5, nine minutes later
        ("A", ALICE),
    ]

    async def test_the_two_regions_become_two_canonical_speakers(self):
        segments, sampler = meeting(self.REUSED)

        out, report = await refine(segments, sampler)

        assert report.labels_split == 1
        assert report.substantial_reassigned >= 1
        early = out[3].speaker_key
        late = out[6].speaker_key
        assert early != late

    async def test_the_provider_label_is_identical_on_both(self):
        # No provenance loss. Both turns still say the provider called them D.
        segments, sampler = meeting(self.REUSED)

        out, _ = await refine(segments, sampler)

        assert out[3].speaker_raw == "D"
        assert out[6].speaker_raw == "D"
        assert raws(out) == ["A", "B", "C", "D", "A", "B", "D", "A"]

    async def test_one_raw_label_now_has_two_canonical_owners(self):
        segments, sampler = meeting(self.REUSED)

        out, _ = await refine(segments, sampler)

        owners = [s.speaker_key for s in out if s.speaker_raw == "D"]
        assert len(set(owners)) == 2

    async def test_everybody_else_keeps_their_own_identity(self):
        segments, sampler = meeting(self.REUSED)

        out, _ = await refine(segments, sampler)

        by_raw = {}
        for segment in out:
            by_raw.setdefault(segment.speaker_raw, set()).add(segment.speaker_key)
        assert len(by_raw["A"]) == 1
        assert len(by_raw["B"]) == 1
        assert len(by_raw["C"]) == 1

    async def test_words_and_timings_survive_the_split(self):
        segments, sampler = meeting(self.REUSED)
        before = [(s.start, s.end, s.text) for s in segments]

        out, _ = await refine(segments, sampler)

        assert [(s.start, s.end, s.text) for s in out] == before
        assert {w.speaker_raw for w in out[6].words} == {"D"}
        assert {w.speaker for w in out[6].words} == {out[6].speaker}


class TestOneLabelOnePerson:
    """Brief fixture D: do not oversplit a voice that merely varies."""

    async def test_substantial_turns_far_apart_stay_one_speaker(self):
        segments, sampler = meeting([
            ("A", ALICE), ("B", BOB), ("C", CAROL),
            ("D", DAVE),
            ("A", ALICE), ("B", BOB),
            ("D", DAVE),                  # <- the same person, much later
            ("A", ALICE),
        ])

        out, report = await refine(segments, sampler)

        assert report.labels_split == 0
        assert out[3].speaker_key == out[6].speaker_key

    @pytest.mark.parametrize("drift", [0.05, 0.10, 0.15])
    async def test_a_voice_that_varies_is_not_two_voices(self, drift):
        # Conditions change across a meeting -- somebody moves, a headset is
        # adjusted. Varying is not separating, and the rule is judged against
        # the label's own spread for exactly this reason.
        later = blend(DAVE, ERIN, drift)
        segments, sampler = meeting([
            ("A", ALICE), ("B", BOB), ("C", CAROL),
            ("D", DAVE),
            ("A", ALICE), ("B", BOB),
            ("D", later),
            ("A", ALICE),
        ])

        out, report = await refine(segments, sampler)

        assert report.labels_split == 0
        assert out[3].speaker_key == out[6].speaker_key

    async def test_a_solo_recording_is_never_split(self):
        segments, sampler = meeting([("A", ALICE)] * 5)

        out, report = await refine(segments, sampler)

        assert report.labels_split == 0
        assert len({s.speaker_key for s in out}) == 1


class TestTheMergeIsNotTheAnswer:
    """Brief fixtures E and F, which pull in opposite directions."""

    async def test_two_labels_that_really_are_one_voice_still_merge(self):
        # E. The over-diarization correction must survive the extra evidence
        # the merge now demands.
        segments, sampler = meeting([
            ("A", ALICE), ("B", BOB), ("D", CAROL), ("E", CAROL),
            ("A", ALICE), ("D", CAROL), ("E", CAROL),
        ])

        out, report = await refine(segments, sampler)

        assert report.merged == 1
        assert out[2].speaker_key == out[3].speaker_key

    @pytest.mark.parametrize("closeness", [0.12, 0.18, 0.25])
    async def test_similar_but_different_humans_are_never_merged(self, closeness):
        # F, and mandatory: the [09:32] report raised the possibility that a
        # false merge caused it. Two people who render similarly must stay two,
        # because a rename undoes an extra speaker and nothing undoes a merge.
        twin = blend(DAVE, ERIN, closeness)
        segments, sampler = meeting([
            ("A", ALICE), ("B", BOB),
            ("D", DAVE), ("E", twin),
            ("A", ALICE),
            ("D", DAVE), ("E", twin),
        ])

        out, report = await refine(segments, sampler)

        assert report.merged == 0
        assert out[2].speaker_key != out[3].speaker_key
        assert raws(out) == ["A", "B", "D", "E", "A", "D", "E"]

    async def test_uncertain_evidence_keeps_the_speakers_apart(self):
        # The asymmetry rule, stated as a test. Anything short of unequivocal
        # leaves two speakers, which the user can merge with one rename.
        segments, sampler = meeting([
            ("A", ALICE), ("B", BOB),
            ("D", DAVE), ("E", blend(DAVE, ALICE, 0.14)),
            ("A", ALICE),
            ("D", DAVE), ("E", blend(DAVE, ALICE, 0.14)),
        ])

        _, report = await refine(segments, sampler)

        assert report.merged == 0


class TestTheDiagnostic:

    async def test_the_two_directions_are_counted_apart(self):
        segments, sampler = meeting(TestOneLabelTwoPeople.REUSED)

        _, report = await refine(segments, sampler)

        line = report.as_log_fields()
        assert "rawLabelsSplit=1" in line
        assert "substantialTurnsReassigned=" in line
        # A split is not a merge, and a reader can tell which way the provider
        # was wrong without opening the transcript.
        assert "mergedLabels=0" in line

    async def test_a_meeting_needing_no_correction_says_so(self):
        segments, sampler = meeting([("A", ALICE), ("B", BOB), ("A", ALICE)])

        _, report = await refine(segments, sampler)

        line = report.as_log_fields()
        assert "rawLabelsSplit=0" in line
        assert "substantialTurnsReassigned=0" in line
        assert "mergedLabels=0" in line
