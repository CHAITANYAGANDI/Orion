"""Reading speakers' names out of the dialogue, and refusing to.

Two things are being tested and only one of them is the feature. The first is
that a meeting which says who its speakers are ends up saying so. The second,
and the longer half of this file, is that everything which merely *looks* like
it says so is turned down — because the cost of the two is not symmetrical. A
speaker left as *Speaker 2* is visibly unfinished and is where the user already
was. A speaker given the wrong name is a fact on the page, in the summary, in
the retrieval passages, and read back out of chat as "Michael said we would ship
on Friday" with a citation under it, and nothing distinguishes that from a true
answer.

The direction test is the one to read first. It is the failure this whole module
is shaped around: a name in a turn almost never belongs to the person saying it.
"""

from __future__ import annotations

import pytest

from app import naming
from app.schemas import Segment, SpeakerNameClaim


def seg(speaker: str, text: str, start: float = 0.0, **extra) -> Segment:
    return Segment(
        start=start, end=start + 3.0, speaker=speaker, text=text,
        speaker_key=extra.pop("key", None), **extra,
    )


def claim(speaker: str, name: str, turn: int, quote: str, basis: str) -> SpeakerNameClaim:
    return SpeakerNameClaim(
        speaker=speaker, name=name, turn=turn, quote=quote, basis=basis
    )


def greeting() -> list[Segment]:
    """The exchange the feature exists for, and the one everybody reads backwards.

    Built fresh per call rather than shared: `apply` writes to the segments it
    is given, so a module-level list would let one test rename the speakers out
    from under the next one.
    """
    return [
        seg("Speaker 1", "Hi, how are you Michael?", 0.0, key="spk_1"),
        seg("Speaker 2", "I am good, Charles.", 4.0, key="spk_2"),
    ]

#: What a correct reading of it produces.
GREETING_CLAIMS = [
    claim("Speaker 2", "Michael", 1, "how are you Michael", "addressed"),
    claim("Speaker 1", "Charles", 2, "I am good, Charles", "addressed"),
]


class TestTheDirection:
    """A name is spoken *to* somebody. It is not a signature."""

    def test_a_greeting_names_the_other_speaker(self):
        assert naming.resolve(GREETING_CLAIMS, greeting()) == {
            "Speaker 1": "Charles",
            "Speaker 2": "Michael",
        }

    def test_it_is_not_the_speaker_who_said_the_name(self):
        # The same two turns, read the way that comes naturally and is wrong:
        # the name on Speaker 1's line must not become Speaker 1's name.
        resolved = naming.resolve(GREETING_CLAIMS, greeting())
        assert resolved["Speaker 1"] != "Michael"
        assert resolved["Speaker 2"] != "Charles"

    def test_addressed_claims_naming_the_talker_are_refused(self):
        # A model that filed it under the speaker anyway. The claim is dropped
        # rather than quietly flipped -- it got the one field that cannot be
        # recovered from the text wrong, so the rest of it is not evidence.
        wrong = [claim("Speaker 1", "Michael", 1, "how are you Michael", "addressed")]
        assert naming.resolve(wrong, greeting()) == {}

    def test_a_self_introduction_names_the_talker(self):
        segments = [
            seg("Speaker 1", "Hello everyone, I'm Michael and I'll be running this.", 0.0),
            seg("Speaker 2", "Great, let's get going.", 6.0),
        ]
        claims = [claim("Speaker 1", "Michael", 1, "I'm Michael", "introduced")]
        assert naming.resolve(claims, segments) == {"Speaker 1": "Michael"}

    def test_introductions_claimed_for_somebody_else_are_refused(self):
        segments = [
            seg("Speaker 1", "Hello everyone, I'm Michael.", 0.0),
            seg("Speaker 2", "Great, let's get going.", 6.0),
        ]
        claims = [claim("Speaker 2", "Michael", 1, "I'm Michael", "introduced")]
        assert naming.resolve(claims, segments) == {}


class TestEvidence:
    """Every claim has to point at words that are really there."""

    def test_a_quote_that_is_not_in_that_turn_is_refused(self):
        invented = [claim("Speaker 2", "Michael", 1, "good to see you Michael", "addressed")]
        assert naming.resolve(invented, greeting()) == {}

    def test_a_quote_from_the_wrong_turn_is_refused(self):
        # Real words, wrong turn number. The turn is what ties a name to a
        # speaker, so a quote that is not where it says it is proves nothing.
        misfiled = [claim("Speaker 1", "Charles", 1, "I am good, Charles", "addressed")]
        assert naming.resolve(misfiled, greeting()) == {}

    def test_a_turn_number_off_the_end_is_refused(self):
        assert naming.resolve(
            [claim("Speaker 2", "Michael", 9, "how are you Michael", "addressed")], greeting()
        ) == {}

    def test_the_name_must_appear_in_the_quote(self):
        # The quote is real and the name is not in it: an inference dressed as
        # a citation, which is the failure mode a citation is meant to prevent.
        segments = [
            seg("Speaker 1", "Right, shall we start with the roadmap?", 0.0),
            seg("Speaker 2", "Yes, let's.", 4.0),
        ]
        claims = [claim("Speaker 2", "Michael", 1, "shall we start with the roadmap", "addressed")]
        assert naming.resolve(claims, segments) == {}

    def test_punctuation_differences_still_match(self):
        # Models re-punctuate freely. That changes no words, so it must not
        # cost a real claim -- the check is normalised, but never fuzzy.
        claims = [claim("Speaker 2", "Michael", 1, "How are you, Michael?", "addressed")]
        assert naming.resolve(claims, greeting()) == {"Speaker 2": "Michael"}

    def test_a_paraphrase_does_not_match(self):
        claims = [claim("Speaker 2", "Michael", 1, "how are you doing Michael", "addressed")]
        assert naming.resolve(claims, greeting()) == {}


class TestAMentionIsNotAnAddress:
    """The commonest way somebody who was not there gets a seat."""

    def test_michael_said_he_would_handle_it(self):
        segments = [
            seg("Speaker 1", "Michael said he would handle the migration.", 0.0),
            seg("Speaker 2", "Good, that clears the sprint.", 5.0),
        ]
        claims = [claim("Speaker 2", "Michael", 1, "Michael said he would handle", "addressed")]
        assert naming.resolve(claims, segments) == {}

    def test_a_possessive_is_a_mention(self):
        # "Michael's" is somebody being talked about. It also must not match
        # the name "Michael" by being a longer word that starts with it.
        segments = [
            seg("Speaker 1", "Let's use Michael's numbers for the forecast.", 0.0),
            seg("Speaker 2", "Fine by me.", 5.0),
        ]
        claims = [claim("Speaker 2", "Michael", 1, "use Michael's numbers", "addressed")]
        assert naming.resolve(claims, segments) == {}

    def test_work_assigned_to_somebody_is_a_mention(self):
        # How a task actually gets handed out in a meeting, and it names
        # somebody who may be on holiday. The person it names is not
        # necessarily in the room, let alone one of the two voices in it.
        segments = [
            seg("Speaker 1", "Chaitanya will finish the gateway by Friday.", 0.0),
            seg("Speaker 2", "That unblocks the mobile build.", 5.0),
        ]
        claims = [claim("Speaker 2", "Chaitanya", 1, "Chaitanya will finish the gateway", "addressed")]
        assert naming.resolve(claims, segments) == {}

    def test_the_same_modal_addressing_somebody_is_kept(self):
        # "Michael, will you..." is the same word doing the opposite job, and
        # the comma that told them apart is gone by the time this is checked.
        segments = [
            seg("Speaker 1", "Michael, will you take the gateway this sprint?", 0.0),
            seg("Speaker 2", "I can pick that up.", 5.0),
        ]
        claims = [claim("Speaker 2", "Michael", 1, "Michael, will you take the gateway", "addressed")]
        assert naming.resolve(claims, segments) == {"Speaker 2": "Michael"}

    def test_a_name_inside_a_longer_word_is_not_the_name(self):
        segments = [
            seg("Speaker 1", "I have an announcement before we start.", 0.0),
            seg("Speaker 2", "Go ahead.", 4.0),
        ]
        claims = [claim("Speaker 2", "Ann", 1, "I have an announcement", "addressed")]
        assert naming.resolve(claims, segments) == {}


class TestWhoIsNear:
    """You are addressed by somebody who is in the conversation with you."""

    def test_a_speaker_two_runs_away_is_refused(self):
        segments = [
            seg("Speaker 1", "Michael, can you take the notes today?", 0.0),
            seg("Speaker 2", "I can pick those up.", 5.0),
            seg("Speaker 1", "Thanks, appreciate it.", 9.0),
            seg("Speaker 2", "No problem at all.", 12.0),
            seg("Speaker 1", "Right, on to the roadmap.", 15.0),
            seg("Speaker 3", "The roadmap slipped by a week.", 18.0),
        ]
        # Speaker 3 does not speak until five runs later. Whoever was being
        # asked to take notes, there is no evidence it was them.
        far = [claim("Speaker 3", "Michael", 1, "Michael, can you take the notes", "addressed")]
        assert naming.resolve(far, segments) == {}
        # The speaker who actually answered is within reach.
        near = [claim("Speaker 2", "Michael", 1, "Michael, can you take the notes", "addressed")]
        assert naming.resolve(near, segments) == {"Speaker 2": "Michael"}

    def test_being_addressed_after_speaking_counts(self):
        # "Thanks, Michael" is said to somebody who has just finished talking,
        # and in a two-line exchange they may never speak again. Looking only
        # forward would lose every sign-off in every transcript.
        segments = [
            seg("Speaker 1", "The numbers are in the deck already.", 0.0),
            seg("Speaker 2", "Perfect, thanks Michael.", 5.0),
        ]
        claims = [claim("Speaker 1", "Michael", 2, "thanks Michael", "addressed")]
        assert naming.resolve(claims, segments) == {"Speaker 1": "Michael"}

    def test_a_long_turn_does_not_push_the_reply_out_of_reach(self):
        # One person speaking in five separate segments is one run, not five.
        segments = [
            seg("Speaker 1", "Morning Michael.", 0.0),
            seg("Speaker 1", "Thanks for making time.", 3.0),
            seg("Speaker 1", "I know it's short notice.", 6.0),
            seg("Speaker 1", "Let's start with the budget.", 9.0),
            seg("Speaker 2", "No problem, happy to help.", 12.0),
        ]
        claims = [claim("Speaker 2", "Michael", 1, "Morning Michael", "addressed")]
        assert naming.resolve(claims, segments) == {"Speaker 2": "Michael"}


class TestNamesThatAreNotNames:
    @pytest.mark.parametrize(
        "text, quote, word",
        [
            ("Thanks everyone, that's us for today.", "Thanks everyone", "everyone"),
            ("Alright guys, let's wrap up.", "Alright guys", "guys"),
            ("Cheers mate, talk tomorrow.", "Cheers mate", "mate"),
            ("Yes sir, that's on the list.", "Yes sir", "sir"),
            ("Good morning team, shall we begin?", "Good morning team", "team"),
        ],
    )
    def test_a_form_of_address_is_not_a_person(self, text, quote, word):
        segments = [seg("Speaker 1", text, 0.0), seg("Speaker 2", "Sounds good.", 5.0)]
        assert naming.resolve(
            [claim("Speaker 2", word, 1, quote, "addressed")], segments
        ) == {}

    def test_a_placeholder_label_is_not_a_name(self):
        segments = [
            seg("Speaker 1", "Over to you, Speaker 2.", 0.0),
            seg("Speaker 2", "Thanks.", 4.0),
        ]
        assert naming.resolve(
            [claim("Speaker 2", "Speaker 2", 1, "Over to you, Speaker 2", "addressed")], segments
        ) == {}

    def test_a_sentence_is_not_a_name(self):
        segments = [
            seg("Speaker 1", "Over to the person who owns the migration work now.", 0.0),
            seg("Speaker 2", "Thanks.", 5.0),
        ]
        assert naming.resolve(
            [claim("Speaker 2", "the person who owns the migration work",
                   1, "the person who owns the migration work", "addressed")], segments
        ) == {}


class TestContradictions:
    def test_the_better_supported_name_wins(self):
        # A nickname is not a contradiction. Four turns calling somebody
        # Michael and one calling them Mike describe one person.
        segments = [
            seg("Speaker 1", "Morning Michael.", 0.0),
            seg("Speaker 2", "Morning.", 3.0),
            seg("Speaker 1", "Michael, did the deploy land?", 6.0),
            seg("Speaker 2", "It did, last night.", 9.0),
            seg("Speaker 1", "Nice one Mike.", 12.0),
            seg("Speaker 2", "Cheers.", 14.0),
        ]
        claims = [
            claim("Speaker 2", "Michael", 1, "Morning Michael", "addressed"),
            claim("Speaker 2", "Michael", 3, "Michael, did the deploy land", "addressed"),
            claim("Speaker 2", "Mike", 5, "Nice one Mike", "addressed"),
        ]
        assert naming.resolve(claims, segments) == {"Speaker 2": "Michael"}

    def test_an_even_split_refuses(self):
        # One each. Both are equally supported, so the honest answer is that
        # the transcript does not say -- the same refusal as the margin check
        # on voice matching, for the same reason.
        segments = [
            seg("Speaker 1", "Morning Michael.", 0.0),
            seg("Speaker 2", "Morning.", 3.0),
            seg("Speaker 1", "Thanks Daniel.", 6.0),
            seg("Speaker 2", "Any time.", 9.0),
        ]
        claims = [
            claim("Speaker 2", "Michael", 1, "Morning Michael", "addressed"),
            claim("Speaker 2", "Daniel", 3, "Thanks Daniel", "addressed"),
        ]
        assert naming.resolve(claims, segments) == {}

    def test_one_name_on_two_speakers_refuses_both(self):
        # No margin here and no winner. Two speakers holding one name is what a
        # mention looks like from the inside, and picking one puts a real
        # person's name on the wrong voice.
        segments = [
            seg("Speaker 1", "Morning Michael.", 0.0),
            seg("Speaker 2", "Morning.", 3.0),
            seg("Speaker 3", "Michael, are you joining?", 6.0),
            seg("Speaker 1", "I am.", 9.0),
        ]
        claims = [
            claim("Speaker 2", "Michael", 1, "Morning Michael", "addressed"),
            claim("Speaker 1", "Michael", 3, "Michael, are you joining", "addressed"),
        ]
        assert naming.resolve(claims, segments) == {}

    def test_a_name_already_worn_in_this_meeting_is_refused(self):
        # Somebody is already called Sarah here -- typed by the user, or
        # resolved by an earlier rematch. Nobody else may be given it.
        segments = [
            seg("Sarah", "Morning Sarah, shall we start?", 0.0),
            seg("Speaker 2", "Let's do it.", 4.0),
        ]
        claims = [claim("Speaker 2", "Sarah", 1, "Morning Sarah", "addressed")]
        assert naming.resolve(claims, segments) == {}


class TestWhatIsNeverTouched:
    def test_a_name_somebody_typed_is_not_a_candidate(self):
        segments = [
            seg("Speaker 1", "How are you Michael?", 0.0),
            seg("Facilitator", "I'm good, thanks.", 4.0),
        ]
        assert naming.open_labels(segments) == ["Speaker 1"]
        claims = [claim("Facilitator", "Michael", 1, "How are you Michael", "addressed")]
        assert naming.resolve(claims, segments) == {}

    def test_apply_leaves_a_typed_name_alone(self):
        # Belt to the resolver's braces: even handed a mapping that names a
        # real person's label, apply refuses to write it.
        segments = [seg("Facilitator", "I'm good, thanks.", 0.0)]
        assert naming.apply(segments, {"Facilitator": "Michael"}) == []
        assert segments[0].speaker == "Facilitator"

    def test_an_unattributed_turn_is_never_named(self):
        # The provider declined to say whose this was, so the words under it
        # may be anybody's. There is nothing here to identify.
        segments = [
            seg("Speaker 1", "How are you Michael?", 0.0),
            seg("Unknown speaker", "I'm good.", 4.0, speaker_status="unknown"),
        ]
        assert naming.open_labels(segments) == ["Speaker 1"]
        claims = [claim("Unknown speaker", "Michael", 1, "How are you Michael", "addressed")]
        assert naming.resolve(claims, segments) == {}

    def test_a_transcript_that_names_nobody_yields_nothing(self):
        segments = [
            seg("Speaker 1", "Shall we start with the roadmap?", 0.0),
            seg("Speaker 2", "Yes, the roadmap slipped a week.", 4.0),
        ]
        assert naming.resolve([], segments) == {}
        assert naming.apply(segments, {}) == []
        assert segments[0].speaker == "Speaker 1"


class TestApplying:
    def test_every_turn_of_that_speaker_moves(self):
        segments = [
            seg("Speaker 1", "Hi, how are you Michael?", 0.0),
            seg("Speaker 2", "I am good, Charles.", 4.0),
            seg("Speaker 2", "Shall we start?", 7.0),
            seg("Speaker 1", "Please do.", 9.0),
        ]
        applied = naming.apply(segments, {"Speaker 1": "Charles", "Speaker 2": "Michael"})
        assert sorted(applied) == ["Charles", "Michael"]
        assert [s.speaker for s in segments] == ["Charles", "Michael", "Michael", "Charles"]

    def test_the_speaker_key_is_untouched(self):
        # The key is what a speaker's colour, their talk-time row and their
        # voiceprint are filed under. A name change must not move it.
        segments = greeting()
        naming.apply(segments, {"Speaker 1": "Charles", "Speaker 2": "Michael"})
        assert [s.speaker_key for s in segments] == ["spk_1", "spk_2"]


class TestTheDialogue:
    def test_turns_are_numbered_from_one(self):
        assert naming.dialogue(greeting()).splitlines() == [
            "1. Speaker 1: Hi, how are you Michael?",
            "2. Speaker 2: I am good, Charles.",
        ]

    def test_empty_turns_do_not_consume_a_number(self):
        # A turn number is how a claim points at its evidence, so the numbering
        # the model reads has to be the numbering `resolve` counts.
        segments = [
            seg("Speaker 1", "Hi, how are you Michael?", 0.0),
            seg("Speaker 2", "   ", 4.0),
            seg("Speaker 2", "I am good, Charles.", 6.0),
        ]
        assert naming.dialogue(segments).splitlines()[1].startswith("2. Speaker 2: I am good")
        assert naming.resolve(GREETING_CLAIMS, segments) == {
            "Speaker 1": "Charles",
            "Speaker 2": "Michael",
        }


class TestThroughThePipeline:
    """The whole path, with the mock provider doing the reading.

    The mock finds names with three patterns rather than a model, and that is
    the point of running it here: it produces *claims* like any other adapter
    and they go through exactly the same verification, so this exercises the
    checks rather than stepping around them.
    """

    @staticmethod
    def _pipeline(segments, **kwargs):
        from app.pipeline import Pipeline
        from app.providers.mock_adapter import MockLlmAdapter
        from app.schemas import TranscriptResponse

        class _Fixed:
            async def transcribe(self, audio, filename, language=None, *, request=None):
                return TranscriptResponse(
                    transcript="\n".join(f"{s.speaker}: {s.text}" for s in segments),
                    language="en",
                    segments=list(segments),
                )

        return Pipeline(_Fixed(), MockLlmAdapter(), **kwargs)

    @pytest.mark.asyncio
    async def test_a_greeting_exchange_comes_out_named(self):
        result = await self._pipeline(greeting()).process("mtg_1", b"", "a.wav")
        assert [s.speaker for s in result.segments] == ["Charles", "Michael"]

    @pytest.mark.asyncio
    async def test_the_flat_transcript_is_rebuilt(self):
        # The summary is written from this string and the export reads it, so a
        # transcript still saying "Speaker 1" beside segments saying "Charles"
        # is the desynchronisation this has to avoid.
        result = await self._pipeline(greeting()).process("mtg_2", b"", "a.wav")
        assert result.transcript.startswith("Charles: Hi, how are you Michael?")
        assert "Speaker 1" not in result.transcript

    @pytest.mark.asyncio
    async def test_a_transcript_naming_nobody_keeps_its_numbers(self):
        quiet = [
            seg("Speaker 1", "Shall we start with the roadmap?", 0.0),
            seg("Speaker 2", "It slipped by about a week.", 4.0),
        ]
        result = await self._pipeline(quiet).process("mtg_3", b"", "a.wav")
        assert [s.speaker for s in result.segments] == ["Speaker 1", "Speaker 2"]

    @pytest.mark.asyncio
    async def test_the_switch_turns_it_off(self):
        pipeline = self._pipeline(greeting(), name_speakers=False)
        result = await pipeline.process("mtg_4", b"", "a.wav")
        assert [s.speaker for s in result.segments] == ["Speaker 1", "Speaker 2"]

    @pytest.mark.asyncio
    async def test_a_failing_model_leaves_the_numbers_alone(self):
        # Naming is the last thing that should be able to fail a meeting: the
        # transcript, the summary and the action items are all still good.
        pipeline = self._pipeline(greeting())

        async def _boom(*args, **kwargs):
            raise RuntimeError("no model today")

        pipeline._llm.identify_speaker_names = _boom
        result = await pipeline.process("mtg_5", b"", "a.wav")
        assert [s.speaker for s in result.segments] == ["Speaker 1", "Speaker 2"]
        assert result.short_summary


class TestTheAdapter:
    """The wire shape, and what a malformed answer costs.

    Follows `tests/test_translate_lines.py`: the real adapter with `_chat_json`
    stood in for, so what is under test is the parsing and none of the network.
    """

    @staticmethod
    def _adapter(reply):
        from app.config import Settings
        from app.providers.openai_adapter import OpenAiLlmAdapter

        async def _chat_json(system, user, *, model=None):
            _chat_json.system = system
            _chat_json.user = user
            return reply

        adapter = OpenAiLlmAdapter.__new__(OpenAiLlmAdapter)
        adapter._settings = Settings(openai_max_retries=0)
        adapter._chat_json = _chat_json  # type: ignore[method-assign]
        return adapter, _chat_json

    @pytest.mark.asyncio
    async def test_claims_are_parsed(self):
        adapter, _ = self._adapter({"speakers": [
            {"speaker": "Speaker 2", "name": "Michael", "turn": 1,
             "quote": "how are you Michael", "basis": "addressed"},
        ]})
        claims = await adapter.identify_speaker_names("1. Speaker 1: hi", ["Speaker 2"])
        assert [(c.speaker, c.name, c.basis) for c in claims] == [
            ("Speaker 2", "Michael", "addressed")
        ]

    @pytest.mark.asyncio
    async def test_one_malformed_claim_does_not_discard_the_others(self):
        # Per item rather than per response. A missing field is one fewer
        # claim, not three fewer -- and every survivor is verified against the
        # transcript anyway.
        adapter, _ = self._adapter({"speakers": [
            {"speaker": "Speaker 1", "name": "Charles"},               # no turn
            {"speaker": "Speaker 2", "name": "Michael", "turn": 1,
             "quote": "how are you Michael", "basis": "addressed"},
            {"speaker": "Speaker 3", "name": "Ana", "turn": 2,
             "quote": "hi Ana", "basis": "shouted"},                   # bad basis
        ]})
        claims = await adapter.identify_speaker_names("1. Speaker 1: hi", ["Speaker 2"])
        assert [c.name for c in claims] == ["Michael"]

    @pytest.mark.asyncio
    async def test_an_empty_answer_is_a_valid_answer(self):
        adapter, _ = self._adapter({"speakers": []})
        assert await adapter.identify_speaker_names("1. Speaker 1: hi", ["Speaker 1"]) == []

    @pytest.mark.asyncio
    async def test_the_brief_states_the_direction_and_the_labels(self):
        # The one instruction that, missing, swaps two people through a whole
        # transcript -- and the label list, without which the model invents its
        # own names for the speakers and nothing matches on the way back.
        adapter, chat = self._adapter({"speakers": []})
        await adapter.identify_speaker_names("1. Speaker 1: hi", ["Speaker 1", "Speaker 2"])
        assert "Michael is NOT Speaker 1" in chat.system
        assert "SPOKEN TO" in chat.system
        assert "Speaker 1, Speaker 2" in chat.user


class TestPrecedence:
    """manual name  >  inferred name  >  the label diarization produced.

    Stated as its own tier list because it is the rule a reader most needs to
    trust: a name somebody typed must survive everything the pipeline does
    afterwards, including a pass whose whole job is assigning names.
    """

    def test_a_manual_name_outranks_an_inference(self):
        assert naming.display_name("Sarah", "attributed", "Michael") == "Sarah"

    def test_an_inference_fills_a_placeholder(self):
        assert naming.display_name("Speaker 2", "attributed", "Michael") == "Michael"

    def test_the_label_stands_when_there_is_no_inference(self):
        assert naming.display_name("Speaker 2", "attributed", None) == "Speaker 2"

    def test_an_unattributed_turn_consults_nothing(self):
        # Checked before the placeholder test: "Unknown speaker" looks like a
        # placeholder and is not one. The provider declined to say whose this
        # was, so there is nobody here to name.
        assert naming.display_name("Unknown speaker", "unknown", "Michael") == "Unknown speaker"

    @pytest.mark.parametrize("typed", ["Sarah", "Facilitator", "Interviewer 2",
                                       "Speaker of the House", "The candidate"])
    def test_names_a_person_chose_are_never_displaced(self, typed):
        # Including the ones that look like labels. Somebody who renamed a
        # speaker to "Interviewer 2" made a decision about their transcript.
        assert naming.display_name(typed, "attributed", "Michael") == typed

    @pytest.mark.parametrize("empty", [None, "", "   "])
    def test_a_turn_with_no_label_at_all_is_left_alone(self, empty):
        # Not a placeholder waiting to be filled -- an unattributed turn
        # wearing a different spelling. `is_unresolved` refuses these for the
        # same reason, and the two have to agree or the guard has a hole.
        assert naming.display_name(empty, "attributed", "Michael") == empty

    def test_apply_honours_the_same_order(self):
        # The precedence is not advisory: `apply` routes through it, so a
        # mapping that names a real person's label writes nothing.
        segments = [
            seg("Sarah", "Morning, how are you Michael?", 0.0, key="spk_1"),
            seg("Speaker 2", "Good thanks.", 4.0, key="spk_2"),
        ]
        applied = naming.apply(segments, {"Sarah": "Michael", "Speaker 2": "Michael"})
        assert applied == ["Michael"]
        assert [s.speaker for s in segments] == ["Sarah", "Michael"]

    def test_a_rematch_result_is_manual_for_this_purpose(self):
        # An acoustic rematch writes a real name, so it lands in the top tier
        # and inference cannot revise it. Voice evidence outranks text here by
        # the same mechanism a typed name does.
        segments = [seg("Sarah", "How are you Michael?", 0.0, key="spk_1")]
        assert naming.apply(segments, {"Sarah": "Michael"}) == []
        assert segments[0].speaker == "Sarah"


class TestEvidenceQuality:
    """A turn has to have a *knowable* owner before it can name anybody.

    Production put a real participant's name on a fragment reading "I." — half a
    second that diarization had handed its own canonical speaker. The name was
    correct about that speaker; the speaker was the mistake.

    The first attempt at a guard here was a blanket "a speaker must have spoken
    for two seconds in total", and it was the wrong instrument: *"Hi, I'm
    Sarah"* lasts about a second and a quarter and is the strongest identity
    evidence a meeting can contain. Suppressing it to catch a half-second
    artefact trades a real feature for a rare fault.

    So the question is asked per turn and it is about *ownership*, not about how
    much somebody said: could anything have checked who spoke this? Below the
    embedder's own floor nothing could, and where the acoustic layer looked and
    failed, `speaker_provisional` says so.
    """

    def test_a_short_self_introduction_still_names_its_speaker(self):
        # Required case 1. Just over the floor, and the best evidence there is.
        segments = [
            seg("Speaker 1", "Right, let us go round the room.", 0.0, key="spk_1"),
            seg("Speaker 2", "Hi, I'm Sarah.", 5.0, key="spk_2"),
        ]
        segments[1].end = 6.3                       # 1.3s

        assert "Speaker 2" in naming.open_labels(segments)
        claims = [claim("Speaker 2", "Sarah", 2, "I'm Sarah", "introduced")]
        assert naming.resolve(claims, segments) == {"Speaker 2": "Sarah"}

    @pytest.mark.parametrize("seconds", [0.8, 1.0, 1.5])
    def test_the_whole_of_a_participant_may_be_one_short_turn(self, seconds):
        segments = [
            seg("Speaker 1", "Who else is on the call?", 0.0, key="spk_1"),
            seg("Speaker 2", "Michael here.", 5.0, key="spk_2"),
        ]
        segments[1].end = 5.0 + seconds

        assert "Speaker 2" in naming.open_labels(segments)
        claims = [claim("Speaker 2", "Michael", 2, "Michael here", "introduced")]
        assert naming.resolve(claims, segments) == {"Speaker 2": "Michael"}

    def test_a_fragment_below_the_embedder_s_floor_cannot_name_anybody(self):
        # Required case 2. Nothing has confirmed who said this and nothing
        # could: `embed` refuses below MIN_SPAN_SECONDS.
        segments = [
            seg("Speaker 1", "Morning Brian, did the deploy land?", 0.0, key="spk_1"),
            seg("Speaker 2", "I.", 4.0, key="spk_2"),
        ]
        segments[1].end = 4.4                       # 0.4s

        assert "Speaker 2" not in naming.open_labels(segments)
        claims = [claim("Speaker 2", "Brian", 1, "Morning Brian", "addressed")]
        assert naming.resolve(claims, segments) == {}

    def test_ownership_the_acoustic_layer_could_not_confirm_cannot_name(self):
        # Required case 5. `speaker_provisional` marks a turn some acoustic
        # pass examined and could not resolve. Nothing sets it now that the
        # meeting-local refinement is gone, so the flag is dormant -- but the
        # rule it drives is still correct and still enforced.
        segments = [
            seg("Speaker 1", "Morning Brian, did the deploy land?", 0.0, key="spk_1"),
            seg("Speaker 2", "Mm hm.", 4.0, key="spk_2"),
        ]
        segments[1].end = 5.5
        segments[1].speaker_provisional = True

        assert "Speaker 2" not in naming.open_labels(segments)
        assert naming.resolve(
            [claim("Speaker 2", "Brian", 1, "Morning Brian", "addressed")], segments) == {}

    def test_one_sound_turn_is_enough_however_many_fragments_surround_it(self):
        # A person diarized imperfectly is still a person. The rule asks whether
        # *any* of their turns has a knowable owner, not whether all of them do.
        segments = [
            seg("Speaker 1", "Morning Brian, did the deploy land?", 0.0, key="spk_1"),
            seg("Speaker 2", "I.", 4.0, key="spk_2"),
            seg("Speaker 2", "It did, last night.", 6.0, key="spk_2"),
        ]
        segments[1].end = 4.4

        assert "Speaker 2" in naming.open_labels(segments)
        assert naming.resolve(
            [claim("Speaker 2", "Brian", 1, "Morning Brian", "addressed")],
            segments) == {"Speaker 2": "Brian"}

    def test_a_short_vocative_exchange_still_resolves(self):
        # Required case 4. Both turns brief, both ownerships sound.
        segments = [
            seg("Speaker 1", "Michael?", 0.0, key="spk_1"),
            seg("Speaker 2", "Yeah, Charles?", 1.2, key="spk_2"),
        ]
        segments[0].end = 1.0
        segments[1].end = 2.4

        claims = [
            claim("Speaker 2", "Michael", 1, "Michael", "addressed"),
            claim("Speaker 1", "Charles", 2, "Yeah, Charles", "addressed"),
        ]
        assert naming.resolve(claims, segments) == {
            "Speaker 1": "Charles", "Speaker 2": "Michael",
        }

    def test_an_unverifiable_turn_is_still_shown_to_the_model(self):
        # Excluded from being *named*, not from the dialogue: removing it would
        # close a gap and make two turns look adjacent that were not, which is
        # exactly what the adjacency rule reads.
        segments = [
            seg("Speaker 1", "Morning Brian, did the deploy land?", 0.0, key="spk_1"),
            seg("Speaker 2", "I.", 4.0, key="spk_2"),
        ]
        segments[1].end = 4.4

        assert "Speaker 2: I." in naming.dialogue(segments)
