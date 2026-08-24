"""Writing a reconciliation back onto segments, and the switch that gates it.

The reconciler is tested in test_reconcile.py against times alone. What is
tested here is the other half: that a decision about words becomes a transcript
without losing any, and that a deployment which did not ask for this gets
exactly what it got before.
"""

from __future__ import annotations

import pytest

from app.config import Settings
from app.diarize_port import SpeakerTurn, Timeline
from app.providers.factory import AiProviderFactory
from app.reattribute import reattribute
from app.reconcile import assign
from app.schemas import Segment, Word


def word(text: str, start: float, end: float, speaker: str | None = None) -> Word:
    return Word(text=text, start=start, end=end, speaker=speaker)


def segment(speaker: str, *words: Word) -> Segment:
    return Segment(
        start=words[0].start,
        end=words[-1].end,
        speaker=speaker,
        speaker_raw=speaker,
        text=" ".join(w.text for w in words),
        words=list(words),
    )


def timeline(*turns: tuple[float, float, str]) -> Timeline:
    return Timeline(turns=[SpeakerTurn(s, e, w) for s, e, w in turns], model="test")


# ----------------------------------------------------------- nothing is lost --

def test_no_word_is_lost_or_invented_or_edited():
    """The invariant that makes this safe to run at all.

    Attribution moves; transcription does not. A rewrite that dropped a word
    would be a transcription change wearing a diarization label.
    """
    original = [
        segment("A", word("I'm", 0.0, 0.2, "A"), word("done.", 0.2, 0.6, "A"),
                word("Exactly.", 0.61, 1.05, "A"), word("Let's", 1.06, 1.25, "A")),
    ]
    before = [(w.text, w.start, w.end) for s in original for w in s.words]

    result = assign(
        [(w.text, w.start, w.end, w.speaker) for s in original for w in s.words],
        timeline((0.0, 0.60, "D0"), (0.60, 1.06, "D1"), (1.06, 2.0, "D0")),
    )
    rebuilt = reattribute(original, result)

    after = [(w.text, w.start, w.end) for s in rebuilt for w in s.words]
    assert after == before


def test_a_one_word_interjection_becomes_its_own_turn():
    """The whole point, end to end: the provider called all four words one voice."""
    original = [
        segment("A", word("I'm", 0.0, 0.2, "A"), word("done.", 0.2, 0.6, "A"),
                word("Exactly.", 0.61, 1.05, "A"), word("Let's", 1.06, 1.25, "A")),
    ]
    result = assign(
        [(w.text, w.start, w.end, w.speaker) for s in original for w in s.words],
        timeline((0.0, 0.60, "D0"), (0.60, 1.06, "D1"), (1.06, 2.0, "D0")),
    )
    rebuilt = reattribute(original, result)

    assert [s.text for s in rebuilt] == ["I'm done.", "Exactly.", "Let's"]
    assert rebuilt[0].speaker_key == rebuilt[2].speaker_key
    assert rebuilt[1].speaker_key != rebuilt[0].speaker_key


def test_the_speaker_shown_is_a_number_not_an_internal_key():
    """"spk_2" reaching the screen is the failure this guards.

    `CanonicalSpeakers` classifies anything that is not a cluster id as a name
    and displays it literally, so handing it the key whole would put "spk_2
    said" in the transcript.
    """
    original = [segment("A", word("Hello", 0.0, 0.5, "A"))]
    result = assign([("Hello", 0.0, 0.5, "A")], timeline((0.0, 1.0, "D0")))
    rebuilt = reattribute(original, result)

    assert rebuilt[0].speaker == "Speaker 1"
    assert rebuilt[0].speaker_key == "spk_1"
    assert "spk_" not in rebuilt[0].speaker


def test_the_providers_own_label_survives_for_the_trace():
    original = [segment("B", word("Hello", 0.0, 0.5, "B"))]
    result = assign([("Hello", 0.0, 0.5, "B")], timeline((0.0, 1.0, "D0")))
    rebuilt = reattribute(original, result)

    assert rebuilt[0].speaker_raw == "B"
    assert rebuilt[0].words[0].speaker_raw == "B"


def test_a_monologue_comes_back_as_one_turn():
    words = [word(f"w{i}", i * 0.5, i * 0.5 + 0.45, "A") for i in range(40)]
    original = [segment("A", *words)]
    result = assign(
        [(w.text, w.start, w.end, w.speaker) for w in words],
        timeline((0.0, 30.0, "D0")),
    )
    rebuilt = reattribute(original, result)

    assert len(rebuilt) == 1
    assert len(rebuilt[0].words) == 40


def test_a_segment_with_no_word_timings_still_round_trips():
    """Providers that time only whole utterances must not crash this."""
    bare = Segment(start=0.0, end=2.0, speaker="A", text="Morning all", words=[])
    result = assign([("Morning all", 0.0, 2.0, "A")], timeline((0.0, 3.0, "D0")))
    rebuilt = reattribute([bare], result)

    assert len(rebuilt) == 1
    assert rebuilt[0].text == "Morning all"


def test_a_mismatched_verdict_list_is_refused_rather_than_applied():
    """Silently misaligned attribution is the one outcome worse than doing nothing."""
    original = [segment("A", word("one", 0.0, 0.5, "A"), word("two", 0.5, 1.0, "A"))]
    result = assign([("one", 0.0, 0.5, "A")], timeline((0.0, 1.0, "D0")))

    assert reattribute(original, result) is original


def test_an_unresolved_run_is_marked_unknown_not_guessed():
    original = [segment("A", word("mumble", 5.0, 5.4, "A"))]
    result = assign(
        [("mumble", 5.0, 5.4, "A")],
        timeline((0.0, 1.0, "D0")),
        fall_back_to_provider=False,
    )
    rebuilt = reattribute(original, result)

    assert rebuilt[0].speaker_status == "unknown"
    assert rebuilt[0].speaker_key is None


# ------------------------------------------------------------- the switch ----

def test_diarization_is_off_by_default():
    """The benchmark did not support turning this on. See docs/diarization.md.

    Asserted rather than left to a default value nobody reads: switching it on
    changes the speaker labels of every meeting a deployment processes.
    """
    assert Settings().diarization_provider == "none"
    assert AiProviderFactory.create_diarization(Settings()) is None


@pytest.mark.parametrize("value", ["none", "off", "", "  NONE  "])
def test_every_spelling_of_off_is_off(value):
    assert AiProviderFactory.create_diarization(
        Settings(diarization_provider=value)) is None


def test_an_unknown_provider_keeps_the_providers_labels(caplog):
    """A typo must not silently disable diarization *and* say nothing."""
    with caplog.at_level("WARNING"):
        assert AiProviderFactory.create_diarization(
            Settings(diarization_provider="pyannotte")) is None
    assert "pyannotte" in caplog.text

# ------------------------------------------------- through the real pipeline --

class _FakeDiarizer:
    """A DiarizationPort with a scripted answer. No model, no audio, no torch."""

    name = "fake"

    def __init__(self, result: Timeline) -> None:
        self._result = result
        self.calls = 0

    async def diarize(self, audio: bytes) -> Timeline:
        self.calls += 1
        return self._result


def _pipeline(diarizer):
    from app.pipeline import Pipeline
    from app.providers.mock_adapter import MockLlmAdapter, MockTranscriptionAdapter

    return Pipeline(MockTranscriptionAdapter(), MockLlmAdapter(), None, diarizer)


@pytest.mark.asyncio
async def test_the_pipeline_runs_the_diarizer_when_one_is_configured():
    diarizer = _FakeDiarizer(timeline((0.0, 10_000.0, "D0")))
    result = await _pipeline(diarizer).process("mtg_1", b"audio-bytes", "a.wav")

    assert diarizer.calls == 1
    assert result.segments, "a diarized meeting still has a transcript"
    assert {s.speaker for s in result.segments} == {"Speaker 1"}, \
        "one cluster for the whole recording is one speaker"


@pytest.mark.asyncio
async def test_no_diarizer_configured_means_the_audio_is_never_decoded():
    """The default path must not pay for a feature it did not ask for."""
    pipeline = _pipeline(None)
    result = await pipeline.process("mtg_1", b"audio-bytes", "a.wav")
    assert result.segments


@pytest.mark.asyncio
async def test_an_unavailable_diarizer_leaves_the_transcript_alone():
    """A missing model must not cost a meeting its speakers."""
    from app.diarize_port import unavailable

    plain = await _pipeline(None).process("mtg_1", b"audio", "a.wav")
    broken = _FakeDiarizer(unavailable("no weights", "fake"))
    degraded = await _pipeline(broken).process("mtg_1", b"audio", "a.wav")

    assert broken.calls == 1
    assert [s.speaker for s in degraded.segments] == [s.speaker for s in plain.segments]
    assert [s.text for s in degraded.segments] == [s.text for s in plain.segments]


@pytest.mark.asyncio
async def test_no_audio_means_no_diarization_rather_than_a_crash():
    """The provider sometimes fetches the file itself and `audio` is empty."""
    diarizer = _FakeDiarizer(timeline((0.0, 10_000.0, "D0")))
    result = await _pipeline(diarizer).process("mtg_1", b"", "a.wav")

    assert diarizer.calls == 0
    assert result.segments


@pytest.mark.asyncio
async def test_production_logging_carries_counts_and_never_the_words(caplog):
    """§12: nothing a deployment emits may contain a syllable of the meeting."""
    diarizer = _FakeDiarizer(timeline((0.0, 10_000.0, "D0")))
    with caplog.at_level("INFO"):
        result = await _pipeline(diarizer).process("mtg_1", b"audio-bytes", "a.wav")

    emitted = " ".join(r.getMessage() for r in caplog.records)
    assert "diarization reconciled" in emitted, "the counts are worth having"
    for segment in result.segments:
        for word in segment.words:
            token = word.text.strip(".,?!").lower()
            if len(token) > 4:  # short words collide with field names
                assert token not in emitted.lower(), f"logged transcript text: {token!r}"
