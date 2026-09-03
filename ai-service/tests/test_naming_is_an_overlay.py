"""Naming may change what a speaker is *called*. It may not change who spoke.

Three identities travel with every segment and they are not interchangeable:

    speaker_raw   "A"          the provider's own cluster. Evidence, never shown.
    speaker_key   "spk_1"      meeting-local ownership. What a colour, a
                               talk-time row are filed under.
    speaker       "Speaker 1"  the display name, and the only mutable one.

`app.naming` writes the third and must not touch the first two. This file is the
proof, written against a realistic AssemblyAI payload and run through the real
parser and the real pipeline rather than hand-built segments — because the
failure being guarded against is a *collapse* somewhere along that path, and a
test that starts halfway down it cannot see one.

The regression that motivated it: a four-minute multi-party recording rendering
as `Speaker 1 (100%)`.
"""

from __future__ import annotations

import pytest

from app.providers.assemblyai_adapter import parse_response


#: Milliseconds per word. Unhurried, and deliberately so: at 300ms a four-word
#: turn lasts 1.2 seconds, which is faster than anybody speaks and thin enough
#: that `naming.MIN_SPEECH_FOR_A_NAME` would refuse to name a real participant.
#: A fixture whose timings are not plausible tests the wrong thing.
_MS_PER_WORD = 600


def _words(text: str, speaker: str, start_ms: int):
    """Word-level detail, which is what the parser prefers over the utterance."""
    step = _MS_PER_WORD
    out = []
    for index, token in enumerate(text.split()):
        out.append({
            "text": token,
            "start": start_ms + index * step,
            "end": start_ms + (index + 1) * step,
            "speaker": speaker,
            "confidence": 0.99,
        })
    return out


def payload(turns) -> dict:
    """An AssemblyAI response carrying `turns` as `[(speaker, text)]`."""
    utterances = []
    cursor = 0
    for speaker, text in turns:
        span = _MS_PER_WORD * len(text.split())
        utterances.append({
            "speaker": speaker,
            "text": text,
            "start": cursor,
            "end": cursor + span,
            "confidence": 0.98,
            "words": _words(text, speaker, cursor),
        })
        cursor += span + 200
    return {
        "language_code": "en_us",
        "text": " ".join(t for _, t in turns),
        "utterances": utterances,
    }


#: The brief's Test A: two people, alternating, each naming the other.
CONVERSATION = [
    ("A", "Hi Michael, how are you?"),
    ("B", "I'm good, Charles."),
    ("A", "Did you finish the deployment?"),
    ("B", "Yes."),
]


def provider_of(parsed):
    """A transcription port that replays one already-parsed response."""

    class _Provider:
        async def transcribe(self, audio, filename, language=None, *, request=None):
            return parsed

    return _Provider()


async def run(turns, llm=None, **kwargs):
    """The whole pipeline over a provider payload. Returns the brief."""
    from app.pipeline import Pipeline
    from app.providers.mock_adapter import MockLlmAdapter

    parsed = parse_response(payload(turns))
    pipeline = Pipeline(provider_of(parsed), llm or MockLlmAdapter(), **kwargs)
    return await pipeline.process("mtg_overlay", b"", "a.wav")


def owners(segments):
    """Raw diarization ownership, which nothing downstream may rewrite."""
    return [(s.speaker_raw, s.speaker_key) for s in segments]


class TestTheProviderParser:
    """Before the pipeline: the payload really does carry two speakers."""

    def test_two_speakers_alternating(self):
        parsed = parse_response(payload(CONVERSATION))
        assert len(parsed.segments) == 4
        assert owners(parsed.segments) == [
            ("A", "spk_1"), ("B", "spk_2"), ("A", "spk_1"), ("B", "spk_2"),
        ]
        assert [s.speaker for s in parsed.segments] == [
            "Speaker 1", "Speaker 2", "Speaker 1", "Speaker 2",
        ]


class TestAMultiSpeakerTranscript:
    """Brief test A. Names may be applied; ownership may not move."""

    @pytest.mark.asyncio
    async def test_raw_diarization_survives_naming(self):
        result = await run(CONVERSATION)
        assert owners(result.segments) == [
            ("A", "spk_1"), ("B", "spk_2"), ("A", "spk_1"), ("B", "spk_2"),
        ]

    @pytest.mark.asyncio
    async def test_there_are_still_two_speakers_never_one(self):
        # The regression, stated as an assertion: a four-turn conversation
        # between two people must never render as one person.
        result = await run(CONVERSATION)
        assert len({s.speaker for s in result.segments}) == 2
        assert len({s.speaker_key for s in result.segments}) == 2

    @pytest.mark.asyncio
    async def test_the_display_names_are_the_ones_the_dialogue_gave(self):
        result = await run(CONVERSATION)
        # A greeted Michael, so B is Michael; B answered Charles, so A is
        # Charles. The alternation is unchanged underneath.
        assert [s.speaker for s in result.segments] == [
            "Charles", "Michael", "Charles", "Michael",
        ]

    @pytest.mark.asyncio
    async def test_timestamps_and_order_are_untouched(self):
        before = parse_response(payload(CONVERSATION)).segments
        after = (await run(CONVERSATION)).segments
        assert [(s.start, s.end) for s in after] == [(s.start, s.end) for s in before]
        assert [s.text for s in after] == [s.text for s in before]

    @pytest.mark.asyncio
    async def test_the_flat_transcript_uses_names_without_moving_anybody(self):
        # A derived string for the summarizer and RAG. Deriving it is fine;
        # what it must not do is be the reason ownership changed.
        result = await run(CONVERSATION)
        assert result.transcript.splitlines()[:2] == [
            "Charles: Hi Michael, how are you?",
            "Michael: I'm good, Charles.",
        ]
        assert owners(result.segments) == [
            ("A", "spk_1"), ("B", "spk_2"), ("A", "spk_1"), ("B", "spk_2"),
        ]


class TestNamingFindsNothing:
    """Brief test B. Silence leaves the numbers exactly where they were."""

    @pytest.mark.asyncio
    async def test_speakers_stay_numbered(self):
        result = await run([("A", "Let's review the release."), ("B", "Sure.")])
        assert [s.speaker for s in result.segments] == ["Speaker 1", "Speaker 2"]
        assert owners(result.segments) == [("A", "spk_1"), ("B", "spk_2")]


class TestTheModelFails:
    """Brief test C. A broken model costs names, never diarization."""

    @pytest.mark.asyncio
    async def test_a_raising_model_changes_nothing(self):
        import asyncio

        from app.pipeline import Pipeline
        from app.providers.mock_adapter import MockLlmAdapter

        parsed = parse_response(payload(CONVERSATION))

        class _Provider:
            async def transcribe(self, audio, filename, language=None, *, request=None):
                return parsed

        llm = MockLlmAdapter()

        async def _boom(*args, **kwargs):
            raise TimeoutError("the model is down")

        llm.identify_speaker_names = _boom
        pipeline = Pipeline(_Provider(), llm)
        result = await pipeline.process("mtg_c", b"", "a.wav")

        assert [s.speaker for s in result.segments] == [
            "Speaker 1", "Speaker 2", "Speaker 1", "Speaker 2",
        ]
        assert owners(result.segments) == [
            ("A", "spk_1"), ("B", "spk_2"), ("A", "spk_1"), ("B", "spk_2"),
        ]

    @pytest.mark.asyncio
    async def test_malformed_claims_change_nothing(self):
        import asyncio

        from app.pipeline import Pipeline
        from app.providers.mock_adapter import MockLlmAdapter

        parsed = parse_response(payload(CONVERSATION))

        class _Provider:
            async def transcribe(self, audio, filename, language=None, *, request=None):
                return parsed

        llm = MockLlmAdapter()

        async def _junk(*args, **kwargs):
            return ["not a claim", None, 42]

        llm.identify_speaker_names = _junk
        result = await Pipeline(_Provider(), llm).process("mtg_c2", b"", "a.wav")
        assert [s.speaker for s in result.segments] == [
            "Speaker 1", "Speaker 2", "Speaker 1", "Speaker 2",
        ]


class TestNamingCollision:
    """Brief test D. One name on two speakers refuses both and merges neither.

    The conversation is its own, because the collision has to be reachable: two
    claims that are each individually well formed and verifiable, which happen
    to land the same name on two different voices. That is what a third party
    called Michael, discussed by two colleagues, actually looks like.
    """

    BOTH_CALLED_MICHAEL = [
        ("A", "Hi Michael, how are you?"),
        ("B", "All good. Michael, shall we start?"),
    ]

    @pytest.mark.asyncio
    async def test_the_claims_are_each_valid_on_their_own(self):
        # Guards the fixture itself: if either claim were rejected for an
        # unrelated reason, this test would pass while proving nothing.
        from app import naming
        from app.schemas import SpeakerNameClaim

        parsed = parse_response(payload(self.BOTH_CALLED_MICHAEL))
        first = [SpeakerNameClaim(speaker="Speaker 2", name="Michael", turn=1,
                                  quote="Hi Michael, how are you", basis="addressed")]
        second = [SpeakerNameClaim(speaker="Speaker 1", name="Michael", turn=2,
                                   quote="Michael, shall we start", basis="addressed")]
        assert naming.resolve(first, parsed.segments) == {"Speaker 2": "Michael"}
        assert naming.resolve(second, parsed.segments) == {"Speaker 1": "Michael"}

    @pytest.mark.asyncio
    async def test_together_they_refuse_and_nobody_is_merged(self):
        from app.providers.mock_adapter import MockLlmAdapter
        from app.schemas import SpeakerNameClaim

        llm = MockLlmAdapter()

        async def _same_name(dialogue, labels, language="en"):
            return [
                SpeakerNameClaim(speaker="Speaker 2", name="Michael", turn=1,
                                 quote="Hi Michael, how are you", basis="addressed"),
                SpeakerNameClaim(speaker="Speaker 1", name="Michael", turn=2,
                                 quote="Michael, shall we start", basis="addressed"),
            ]

        llm.identify_speaker_names = _same_name
        result = await run(self.BOTH_CALLED_MICHAEL, llm=llm)

        # Applied, this is exactly the "Speaker 1 (100%)" failure. Refused.
        assert [s.speaker for s in result.segments] == ["Speaker 1", "Speaker 2"]
        assert len({s.speaker_key for s in result.segments}) == 2
        assert owners(result.segments) == [("A", "spk_1"), ("B", "spk_2")]


class TestAnExistingManualIdentity:
    """Brief test E. A name a person typed survives, and pulls nobody into it."""

    @pytest.mark.asyncio
    async def test_a_named_speaker_is_not_overwritten_or_merged_into(self):
        from app.pipeline import Pipeline
        from app.providers.mock_adapter import MockLlmAdapter

        parsed = parse_response(payload(CONVERSATION))
        # Somebody already renamed the first voice, as a reprocess of an edited
        # meeting would arrive.
        for segment in parsed.segments:
            if segment.speaker_key == "spk_1":
                segment.speaker = "Charles"

        class _Provider:
            async def transcribe(self, audio, filename, language=None, *, request=None):
                return parsed

        result = await Pipeline(_Provider(), MockLlmAdapter()).process(
            "mtg_e", b"", "a.wav"
        )
        assert [s.speaker for s in result.segments] == [
            "Charles", "Michael", "Charles", "Michael",
        ]
        assert owners(result.segments) == [
            ("A", "spk_1"), ("B", "spk_2"), ("A", "spk_1"), ("B", "spk_2"),
        ]

    @pytest.mark.asyncio
    async def test_the_other_voice_cannot_be_given_the_taken_name(self):
        from app.pipeline import Pipeline
        from app.providers.mock_adapter import MockLlmAdapter
        from app.schemas import SpeakerNameClaim

        parsed = parse_response(payload(CONVERSATION))
        for segment in parsed.segments:
            if segment.speaker_key == "spk_1":
                segment.speaker = "Charles"

        class _Provider:
            async def transcribe(self, audio, filename, language=None, *, request=None):
                return parsed

        llm = MockLlmAdapter()

        async def _steal(dialogue, labels, language="en"):
            return [SpeakerNameClaim(speaker="Speaker 2", name="Charles", turn=1,
                                     quote="Hi Michael, how are you", basis="addressed")]

        llm.identify_speaker_names = _steal
        result = await Pipeline(_Provider(), llm).process("mtg_e2", b"", "a.wav")

        # Two people, one of them called Charles. Not two Charleses, and not
        # one Charles holding the whole meeting.
        assert [s.speaker for s in result.segments] == [
            "Charles", "Speaker 2", "Charles", "Speaker 2",
        ]


class TestTheSwitchChangesOnlyNames:
    """Brief test I, offline half: the feature is an overlay or it is nothing."""

    @pytest.mark.asyncio
    async def test_diarization_is_identical_on_and_off(self):
        on = await run(CONVERSATION, name_speakers=True)
        off = await run(CONVERSATION, name_speakers=False)

        assert owners(on.segments) == owners(off.segments)
        assert [(s.start, s.end, s.text) for s in on.segments] == [
            (s.start, s.end, s.text) for s in off.segments
        ]
        # The only difference is what they are called.
        assert [s.speaker for s in on.segments] != [s.speaker for s in off.segments]


class TestOwnershipIsTheKeyNotTheName:
    """The write is keyed on canonical identity, not on the string on screen.

    One-to-one with the label today, so these pass either way on current data.
    They exist to pin the direction of the dependency: the display name must
    never be what decides which utterances move together, because a display name
    is the one thing about a speaker that two people can share.
    """

    @pytest.mark.asyncio
    async def test_every_utterance_of_a_key_moves_together(self):
        result = await run(CONVERSATION)
        by_key = {}
        for s in result.segments:
            by_key.setdefault(s.speaker_key, set()).add(s.speaker)
        # One display name per canonical speaker, and no key left half-renamed.
        assert by_key == {"spk_1": {"Charles"}, "spk_2": {"Michael"}}

    def test_apply_writes_by_key_even_when_labels_collide(self):
        # A constructed transcript where two different canonical speakers carry
        # the same placeholder label. Unreachable from `CanonicalSpeakers`,
        # which numbers them apart -- so this is guarding the property rather
        # than a live path. Keyed on the label, the second speaker would be
        # swept up by the first one's name.
        from app import naming
        from app.schemas import Segment

        segments = [
            Segment(start=0, end=2, speaker="Speaker 1", speaker_key="spk_1", text="One."),
            Segment(start=2, end=4, speaker="Speaker 1", speaker_key="spk_2", text="Two."),
        ]
        applied = naming.apply(segments, {"Speaker 1": "Charles"})

        # Neither is named. Naming both would be the merge -- two canonical
        # speakers wearing one name -- and naming whichever came first would be
        # answering a question the evidence did not settle.
        assert applied == []
        assert [s.speaker for s in segments] == ["Speaker 1", "Speaker 1"]
        assert [s.speaker_key for s in segments] == ["spk_1", "spk_2"]

    def test_a_transcript_with_no_keys_still_renames_by_label(self):
        # Recorded before canonical keys existed, where the label is the only
        # identity there is. Falling back is what those transcripts have always
        # done; refusing would leave them permanently unnameable.
        from app import naming
        from app.schemas import Segment

        segments = [
            Segment(start=0, end=2, speaker="Speaker 1", text="One."),
            Segment(start=2, end=4, speaker="Speaker 2", text="Two."),
        ]
        assert naming.apply(segments, {"Speaker 1": "Charles"}) == ["Charles"]
        assert [s.speaker for s in segments] == ["Charles", "Speaker 2"]
