"""One tiny turn filed under the wrong speaker, while that speaker stays real.

The production transcript:

    [02:38]  Speaker 1   Absolutely. Yeah.
    [02:41]  Speaker 3   Yeah.                      <- 0.4s, actually Speaker 1
    [02:41]  Speaker 1   And vulnerability management was one of the features...
    ...
    [03:25]  Speaker 3   So we have the Jira stuff is pretty good...   <- really them

Two corrections are possible here and only one of them is right.

**Merging the labels globally** — deciding provider `C` *is* `A` — would fix the
02:41 line and delete a participant: the 03:25 turn is genuinely Speaker 3, with
minutes of their own speech behind it. That is `_merge_labels`, and it is the
wrong tool.

**Correcting the single turn** leaves `C` a real speaker everywhere else and
moves one segment's ownership. That is `_correct_islands`, and it is what these
tests are about.

The distinction has a consequence for the data model: once one `C` segment can
be `spk_1` while another is `spk_3`, `speaker_raw -> speaker_key` stops being a
one-to-one mapping for the meeting. It remains the default; a segment may
override it. `speaker_raw` is never rewritten either way.

Almost everything below is a refusal, because a rule that reassigned short turns
on adjacency alone would silently delete every genuine interjection in the
product — and an interjection is one of the most ordinary things in a
conversation.
"""

from __future__ import annotations

import pytest

from app.providers.ecapa_embedder import MIN_SPAN_SECONDS
from app.rediarize import Limits, SpeakerRefiner
from tests.test_rediarize import ALICE, BOB, blend, refine, seg, timeline, voice

CAROL = voice(3)


def realistic(factory):
    """The harness sampler, wearing the real embedder's refusal floor.

    `ecapa_embedder.embed` raises below `MIN_SPAN_SECONDS` (0.8s) rather than
    returning a vector it does not believe, and `_default_sampler` turns that
    into None. The plain test sampler answers down to 0.4s, which would let
    these tests exercise a path production never reaches -- and the whole point
    of the micro-turn work is what happens when the model *declines*.
    """

    def build(audio):
        inner = factory(audio)

        def sample(start: float, end: float):
            if end - start < MIN_SPAN_SECONDS:
                return None
            return inner(start, end)

        return sample

    return build


def meeting(plan):
    """`plan` is `[(provider_label, seconds, voice)]`, laid end to end.

    The *voice* is the acoustic truth and the *label* is what the provider
    claimed — so a row whose label disagrees with its voice is a provider
    mistake, which is the whole subject here.
    """
    order: dict[str, int] = {}
    segments, spans = [], []
    at = 0.0
    for label, seconds, vec in plan:
        if label not in order:
            order[label] = len(order) + 1
        number = order[label]
        words = max(2, int(seconds * 2))
        segment = seg(at, at + seconds, f"Speaker {number}", f"spk_{number}", n=words)
        segment.speaker_raw = label
        for word in segment.words:
            word.speaker_raw = label
        segments.append(segment)
        spans.append((at, at + seconds, vec))
        at += seconds
    return segments, realistic(timeline(*spans))


def keys(segments):
    return [s.speaker_key for s in segments]


def raws(segments):
    return [s.speaker_raw for s in segments]


#: The production shape. The 0.4s `C` is acoustically ALICE; the 30s `C` at the
#: end is genuinely CAROL, which is what makes global merging the wrong answer.
PRODUCTION = [
    ("A", 30.0, ALICE),
    ("B", 20.0, BOB),
    ("A", 30.0, ALICE),
    ("C", 0.4, ALICE),      # <- the mislabelled "Yeah"
    ("A", 30.0, ALICE),
    ("C", 30.0, CAROL),     # <- the real Speaker 3
]


class TestTheProductionShape:
    """The acceptance criterion, as assertions."""

    async def test_the_tiny_turn_moves_to_the_speaker_around_it(self):
        segments, sampler = meeting(PRODUCTION)

        out, report = await refine(segments, sampler)

        assert report.islands_examined >= 1
        assert report.islands_corrected == 1
        assert keys(out) == ["spk_1", "spk_2", "spk_1", "spk_1", "spk_1", "spk_3"]

    async def test_the_real_speaker_three_is_untouched(self):
        # The whole reason this is not a merge. Correcting 02:41 must not cost
        # the meeting a participant.
        segments, sampler = meeting(PRODUCTION)

        out, report = await refine(segments, sampler)

        assert report.merged == 0
        assert out[-1].speaker_key == "spk_3"
        assert out[-1].speaker == "Speaker 3"

    async def test_the_provider_label_is_never_rewritten(self):
        segments, sampler = meeting(PRODUCTION)

        out, _ = await refine(segments, sampler)

        assert raws(out) == ["A", "B", "A", "C", "A", "C"]

    async def test_one_provider_label_now_carries_two_canonical_owners(self):
        # The architectural consequence, asserted rather than assumed: `C` is
        # `spk_1` once and `spk_3` once, in the same meeting.
        segments, sampler = meeting(PRODUCTION)

        out, _ = await refine(segments, sampler)

        by_raw_c = [s.speaker_key for s in out if s.speaker_raw == "C"]
        assert by_raw_c == ["spk_1", "spk_3"]

    async def test_words_follow_the_correction_but_keep_their_token(self):
        segments, sampler = meeting(PRODUCTION)

        out, _ = await refine(segments, sampler)

        island = out[3]
        assert {w.speaker for w in island.words} == {"Speaker 1"}
        assert {w.speaker_raw for w in island.words} == {"C"}

    async def test_timings_and_text_are_not_disturbed(self):
        segments, sampler = meeting(PRODUCTION)
        before = [(s.start, s.end, s.text) for s in segments]

        out, _ = await refine(segments, sampler)

        assert [(s.start, s.end, s.text) for s in out] == before


class TestWhenItMustRefuse:

    async def test_a_genuine_interjection_is_preserved(self):
        # Brief B. The same shape, and the tiny turn really is the third
        # speaker. Reassigning it would put words in somebody else's mouth --
        # and this is the common case, not the rare one.
        segments, sampler = meeting([
            ("A", 30.0, ALICE),
            ("B", 20.0, BOB),
            ("A", 30.0, ALICE),
            ("C", 0.4, CAROL),      # <- really them
            ("A", 30.0, ALICE),
            ("C", 30.0, CAROL),
        ])

        out, report = await refine(segments, sampler)

        assert report.islands_corrected == 0
        assert out[3].speaker_key == "spk_3"
        assert raws(out) == ["A", "B", "A", "C", "A", "C"]

    @pytest.mark.parametrize("mix", [0.5, 0.45, 0.55])
    async def test_an_ambiguous_micro_turn_keeps_the_provider_s_answer(self, mix):
        # Brief C. The audio is genuinely between the two voices, so there is
        # no answer to give and the provider's stands.
        segments, sampler = meeting([
            ("A", 30.0, ALICE),
            ("B", 20.0, BOB),
            ("A", 30.0, ALICE),
            ("C", 0.4, blend(ALICE, CAROL, mix)),
            ("A", 30.0, ALICE),
            ("C", 30.0, CAROL),
        ])

        out, report = await refine(segments, sampler)

        assert report.islands_corrected == 0
        assert out[3].speaker_key == "spk_3"

    async def test_a_short_turn_between_two_different_speakers_is_left_alone(self):
        # REVERTED. Correcting these was tried and withdrawn: it is the only
        # mechanism able to move the *start* of a legitimate turn onto the
        # speaker before it, and three production regressions had exactly that
        # shape. With differing neighbours there is no continuous reading to
        # test against, so nothing is assumed from either side.
        segments, sampler = meeting([
            ("A", 30.0, ALICE),
            ("B", 20.0, BOB),
            ("A", 30.0, ALICE),
            ("C", 0.4, ALICE),      # acoustically the previous speaker
            ("B", 30.0, BOB),
            ("C", 30.0, CAROL),
        ])

        out, report = await refine(segments, sampler)

        assert report.islands_corrected == 0
        assert report.islands_ambiguous == 1
        assert out[3].speaker_key == "spk_3"
        assert out[3].speaker_raw == "C"

    async def test_a_leading_fragment_of_a_turn_is_not_pulled_backwards(self):
        # The production regression, as an assertion. "Yeah, same." opening a
        # legitimate Speaker 4 turn must not be reassigned to whoever spoke
        # before it -- that split one correct turn into two wrong ones.
        segments, sampler = meeting([
            ("A", 30.0, ALICE),
            ("C", 30.0, CAROL),
            ("B", 0.4, BOB),        # leading fragment of the following B turn
            ("B", 20.0, BOB),
        ])

        out, report = await refine(segments, sampler)

        assert report.islands_corrected == 0
        assert out[2].speaker_key == out[3].speaker_key

    async def test_a_third_voice_between_two_different_speakers_is_preserved(self):
        # Both sides contaminated, so neither agrees and nothing is assumed.
        segments, sampler = meeting([
            ("A", 30.0, ALICE),
            ("B", 20.0, BOB),
            ("A", 30.0, ALICE),
            ("C", 0.4, CAROL),      # <- genuinely the third speaker
            ("B", 30.0, BOB),
            ("C", 30.0, CAROL),
        ])

        out, report = await refine(segments, sampler)

        assert report.islands_corrected == 0
        assert out[3].speaker_key == "spk_3"

    async def test_the_text_of_the_island_is_irrelevant(self):
        # Brief 4. "Yeah", "No", "Exactly" -- the same audio must produce the
        # same answer whatever the words are, because the words are never read.
        outcomes = []
        for text in ("Yeah.", "No.", "Right.", "Exactly.", "Sure.", "Okay."):
            segments, sampler = meeting(PRODUCTION)
            segments[3].text = text
            for word in segments[3].words:
                word.text = text
            out, report = await refine(segments, sampler)
            outcomes.append((report.islands_corrected, keys(out)))

        assert len(set(map(str, outcomes))) == 1

    async def test_no_embedder_leaves_every_island_alone(self):
        segments, _ = meeting(PRODUCTION)
        before = keys(segments)
        refiner = SpeakerRefiner()
        refiner._checked, refiner._embedder = True, None

        async def loader():
            return b"audio"

        out, report = await refiner.refine(list(segments), loader)

        assert keys(out) == before
        assert report.islands_corrected == 0


class TestRegions:

    async def test_two_short_turns_in_a_row_are_one_region(self):
        # Brief E. Examined once as a region rather than twice as neighbours of
        # each other, so the answer for one cannot depend on the order the
        # other was decided in.
        segments, sampler = meeting([
            ("A", 30.0, ALICE),
            ("B", 20.0, BOB),
            ("A", 30.0, ALICE),
            ("C", 0.4, ALICE),
            ("C", 0.4, ALICE),
            ("A", 30.0, ALICE),
            ("C", 30.0, CAROL),
        ])

        out, report = await refine(segments, sampler)

        assert report.islands_examined == 1
        assert keys(out)[2:6] == ["spk_1", "spk_1", "spk_1", "spk_1"]
        assert out[-1].speaker_key == "spk_3"

    async def test_a_long_turn_is_not_an_island(self):
        # Being surrounded is only a filter. A turn with enough audio to speak
        # for itself is the split search's business, not this one's.
        segments, sampler = meeting([
            ("A", 30.0, ALICE),
            ("C", 20.0, CAROL),
            ("A", 30.0, ALICE),
        ])

        _, report = await refine(segments, sampler)

        assert report.islands_examined == 0

    async def test_an_unattributed_island_is_not_given_an_owner(self):
        segments, sampler = meeting(PRODUCTION)
        segments[3].speaker_status = "unknown"
        segments[3].speaker = "Unknown speaker"
        segments[3].speaker_key = None

        out, report = await refine(segments, sampler)

        assert report.islands_corrected == 0
        assert out[3].speaker_key is None
        assert out[3].speaker == "Unknown speaker"


class TestTheDiagnostic:

    async def test_counts_the_three_outcomes_apart(self):
        segments, sampler = meeting(PRODUCTION)

        _, report = await refine(segments, sampler)

        line = report.as_log_fields()
        assert "microTurnsExamined=1" in line
        assert "microTurnsCorrected=1" in line
        assert "microTurnsAmbiguous=0" in line
        # An island correction is not a label merge, and the line keeps them
        # apart so a reader can tell which mechanism acted.
        assert "mergedLabels=0" in line

    async def test_an_ambiguous_island_is_counted_as_such(self):
        segments, sampler = meeting([
            ("A", 30.0, ALICE),
            ("B", 20.0, BOB),
            ("A", 30.0, ALICE),
            ("C", 0.4, blend(ALICE, CAROL, 0.5)),
            ("A", 30.0, ALICE),
            ("C", 30.0, CAROL),
        ])

        _, report = await refine(segments, sampler)

        assert "microTurnsExamined=1" in report.as_log_fields()
        assert "microTurnsAmbiguous=1" in report.as_log_fields()
        assert "microTurnsCorrected=0" in report.as_log_fields()


class TestDownstream:
    """What the rest of the product is handed once a turn has been re-owned."""

    @staticmethod
    async def _run(plan):
        from app.pipeline import Pipeline
        from app.providers.mock_adapter import MockLlmAdapter
        from app.schemas import TranscriptResponse

        segments, sampler = meeting(plan)

        class _Provider:
            async def transcribe(self, audio, filename, language=None, *, request=None):
                joined = "\n".join(f"{x.speaker}: {x.text}" for x in segments)
                return TranscriptResponse(
                    transcript=joined, language="en", segments=list(segments),
                )

        async def loader():
            return b"audio"

        pipeline = Pipeline(_Provider(), MockLlmAdapter(),
                            refiner=SpeakerRefiner(sampler_for=sampler),
                            name_speakers=False)
        return await pipeline.process("mtg_island", b"a", "a.wav", audio_loader=loader)

    async def test_the_flat_transcript_uses_the_corrected_owner(self):
        # Brief H. The summary, the retrieval passages and the export all read
        # this string. It must carry the corrected ownership, and must not fall
        # back to the provider's label merely because the raw token is kept.
        result = await self._run(PRODUCTION)

        lines = result.transcript.splitlines()
        assert lines[3].startswith("Speaker 1:")      # the corrected micro-turn
        assert lines[5].startswith("Speaker 3:")      # the real Speaker 3
        assert "C:" not in result.transcript

    async def test_talk_time_is_computed_from_corrected_ownership(self):
        # Brief G, on this side of the wire: the segments Spring will total up
        # carry the corrected key, and the provider token rides along unused.
        result = await self._run(PRODUCTION)

        held = {}
        for segment in result.segments:
            held[segment.speaker_key] = held.get(segment.speaker_key, 0.0) + (
                segment.end - segment.start)

        # Three 30s turns plus the 0.4s island now owned by them; Speaker 3
        # keeps only the turn that is really theirs.
        assert held["spk_1"] == pytest.approx(90.4)
        assert held["spk_2"] == pytest.approx(20.0)
        assert held["spk_3"] == pytest.approx(30.0)
        assert [s.speaker_raw for s in result.segments] == ["A", "B", "A", "C", "A", "C"]


class TestNamingConsumesCorrectedOwnership:
    """Required case 3: naming sees the corrected owner, never the stale one.

    Ordering, asserted rather than assumed. `app.pipeline` runs refinement,
    then reattribution, then naming — so by the time a name is attached to a
    canonical speaker, every acoustic correction has already happened. A
    fragment the provider filed under the wrong person cannot carry that
    person's name into the transcript, because it is no longer theirs.
    """

    @staticmethod
    def _named(plan, claims):
        from app import naming as naming_module
        return plan, claims, naming_module

    async def test_the_corrected_owner_is_what_naming_is_offered(self):
        from app import naming

        segments, sampler = meeting(PRODUCTION)
        out, report = await refine(segments, sampler)
        assert report.islands_corrected == 1

        # The fragment now belongs to Speaker 1, so Speaker 3 is nowhere near
        # it -- and any name the conversation gives Speaker 1 lands on a turn
        # that is genuinely theirs.
        assert out[3].speaker == "Speaker 1"
        assert "Speaker 3" in naming.open_labels(out)
        assert "Speaker 1" in naming.open_labels(out)

    async def test_a_stale_owner_cannot_pull_a_name_onto_the_fragment(self):
        from app import naming

        segments, sampler = meeting(PRODUCTION)
        out, _ = await refine(segments, sampler)

        # A claim naming the speaker who *used* to own the fragment. It resolves
        # against Speaker 3's real turn, and the fragment is not part of it.
        claims = [_claim("Speaker 3", "Brian", out)]
        resolved = naming.resolve([c for c in claims if c], out)
        assert resolved.get("Speaker 1") is None

    async def test_an_unresolved_island_is_marked_for_naming(self):
        # The other outcome: examined, not resolved. `speaker_provisional` is
        # how that fact reaches naming, and it is the only thing that does.
        segments, sampler = meeting([
            ("A", 30.0, ALICE),
            ("B", 20.0, BOB),
            ("A", 30.0, ALICE),
            ("C", 0.4, blend(ALICE, CAROL, 0.5)),
            ("A", 30.0, ALICE),
            ("C", 30.0, CAROL),
        ])

        out, report = await refine(segments, sampler)

        assert report.islands_ambiguous == 1
        assert out[3].speaker_provisional is True
        # Speaker 3 still has a substantial turn of their own, so they remain
        # nameable -- the fragment simply is not part of the case for it.
        from app import naming
        assert "Speaker 3" in naming.open_labels(out)

    async def test_the_flag_never_leaves_the_process(self):
        # It is read by naming a few lines later and by nothing else. Spring has
        # no column for it and the API does not expose it.
        segments, sampler = meeting(PRODUCTION)
        out, _ = await refine(segments, sampler)

        assert "speakerProvisional" not in out[3].model_dump(by_alias=True)
        assert "speaker_provisional" not in out[3].model_dump()


def _claim(speaker, name, segments):
    """A well-formed claim for `speaker`, anchored to a turn they really hold."""
    from app.schemas import SpeakerNameClaim

    for index, segment in enumerate(segments, start=1):
        if segment.speaker != speaker:
            continue
        return SpeakerNameClaim(speaker=speaker, name=name, turn=index,
                                quote=segment.text[:20], basis="introduced")
    return None
