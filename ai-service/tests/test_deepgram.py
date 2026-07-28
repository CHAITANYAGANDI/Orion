"""Deepgram response mapping.

Diarization is the whole point of this adapter, so the tests concentrate on
speaker attribution: that turns are separated, that the label a user will
rename is stable, and that a response missing the parts we prefer degrades to
something usable rather than to an empty transcript.

Everything here runs against captured response shapes — no key, no network.
"""

from __future__ import annotations

import httpx
import pytest

from app.config import Settings
from app.providers.deepgram_adapter import (
    DeepgramTranscriptionAdapter,
    parse_response,
    speaker_label,
)


def _utterance(speaker, text, start=0.0, end=1.0):
    return {"speaker": speaker, "transcript": text, "start": start, "end": end}


def _word(speaker, word, start=0.0, end=0.5, punctuated=None):
    return {
        "speaker": speaker, "word": word, "start": start, "end": end,
        "punctuated_word": punctuated or word,
    }


def _payload(*, utterances=None, words=None, transcript="", language="en"):
    return {
        "metadata": {"model_info": {"language": language}},
        "results": {
            "channels": [{
                "detected_language": language,
                "alternatives": [{"transcript": transcript, "words": words or []}],
            }],
            **({"utterances": utterances} if utterances is not None else {}),
        },
    }


# --------------------------------------------------------------------------- #
# Diarization
# --------------------------------------------------------------------------- #

def test_utterances_become_one_segment_per_turn():
    result = parse_response(_payload(utterances=[
        _utterance(0, "I'll take the JWT work.", 0.0, 2.5),
        _utterance(1, "Fine, but it needs to land Friday.", 2.6, 5.0),
        _utterance(0, "Understood.", 5.1, 6.0),
    ]))

    assert [s.speaker for s in result.segments] == ["Speaker 1", "Speaker 2", "Speaker 1"]
    assert result.segments[1].text == "Fine, but it needs to land Friday."
    assert result.segments[1].start == 2.6


def test_transcript_carries_speaker_attribution():
    """The LLM reads this text; attributing an action item needs the name."""
    result = parse_response(_payload(utterances=[
        _utterance(0, "Priya will finish the migration."),
        _utterance(1, "I'll review it."),
    ]))

    assert "Speaker 1: Priya will finish the migration." in result.transcript
    assert "Speaker 2: I'll review it." in result.transcript


def test_speaker_labels_are_one_based_and_renameable():
    # Deepgram counts from zero; users do not.
    assert speaker_label(0) == "Speaker 1"
    assert speaker_label(3) == "Speaker 4"


def test_missing_speaker_falls_back_to_a_single_label():
    # Diarization off, or an old response shape: everything is one speaker
    # rather than crashing or emitting "Speaker None".
    assert speaker_label(None) == "Speaker 1"
    assert speaker_label("nonsense") == "Speaker 1"
    assert speaker_label(True) == "Speaker 1"


# --------------------------------------------------------------------------- #
# Word-grouping fallback
# --------------------------------------------------------------------------- #

def test_words_are_grouped_when_utterances_are_absent():
    result = parse_response(_payload(words=[
        _word(0, "I'll", 0.0, 0.3), _word(0, "take", 0.3, 0.6), _word(0, "it", 0.6, 0.9),
        _word(1, "Thanks", 1.0, 1.5),
    ]))

    assert len(result.segments) == 2
    assert result.segments[0].text == "I'll take it"
    assert result.segments[0].speaker == "Speaker 1"
    assert result.segments[1].speaker == "Speaker 2"
    # Timings must span the whole grouped turn, not just the first word.
    assert result.segments[0].start == 0.0
    assert result.segments[0].end == 0.9


def test_word_grouping_prefers_the_punctuated_form():
    result = parse_response(_payload(words=[
        _word(0, "hello", 0.0, 0.4, punctuated="Hello,"),
        _word(0, "team", 0.4, 0.8, punctuated="team."),
    ]))
    assert result.segments[0].text == "Hello, team."


def test_speaker_zero_starts_a_turn_correctly():
    """Speaker 0 is falsy — a truthiness check here would drop the first turn."""
    result = parse_response(_payload(words=[_word(0, "First", 0.0, 0.5)]))
    assert len(result.segments) == 1
    assert result.segments[0].speaker == "Speaker 1"
    assert result.segments[0].text == "First"


def test_utterances_win_over_words():
    """Deepgram's own segmentation is better than anything reconstructed."""
    result = parse_response(_payload(
        utterances=[_utterance(0, "From the utterance.")],
        words=[_word(1, "From"), _word(1, "the"), _word(1, "words")],
    ))
    assert len(result.segments) == 1
    assert result.segments[0].text == "From the utterance."


# --------------------------------------------------------------------------- #
# Language
# --------------------------------------------------------------------------- #

def test_detected_language_is_normalised_to_an_iso_code():
    # Deepgram may answer with a locale; the rest of the app stores two letters.
    assert parse_response(_payload(utterances=[_utterance(0, "Hola")], language="es-419")).language == "es"
    assert parse_response(_payload(utterances=[_utterance(0, "Hi")], language="en-US")).language == "en"


def test_language_defaults_to_english_when_absent():
    assert parse_response({"results": {"channels": []}}).language == "en"


# --------------------------------------------------------------------------- #
# Degradation
# --------------------------------------------------------------------------- #

def test_empty_response_does_not_explode():
    result = parse_response({})
    assert result.transcript == ""
    assert result.segments == []


def test_flat_transcript_is_used_when_there_are_no_segments():
    result = parse_response(_payload(transcript="Some words with no timings."))
    assert result.transcript == "Some words with no timings."


def test_blank_utterances_are_dropped():
    result = parse_response(_payload(utterances=[
        _utterance(0, "Real content."),
        _utterance(1, "   "),
        _utterance(1, ""),
    ]))
    assert len(result.segments) == 1


def test_malformed_entries_are_skipped_not_fatal():
    result = parse_response(_payload(utterances=[
        "not a dict",
        _utterance(0, "Survives."),
        {"speaker": 1},  # no transcript
    ]))
    assert len(result.segments) == 1
    assert result.segments[0].text == "Survives."


def test_non_numeric_timings_default_rather_than_crash():
    result = parse_response(_payload(utterances=[
        {"speaker": 0, "transcript": "Hi", "start": "oops", "end": None},
    ]))
    assert result.segments[0].start == 0.0
    assert result.segments[0].end == 0.0


# --------------------------------------------------------------------------- #
# Transport
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_request_asks_for_diarization_and_utterances():
    """The feature is a query parameter — losing it silently loses the feature."""
    seen: dict = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["params"] = dict(request.url.params)
        seen["auth"] = request.headers.get("Authorization")
        return httpx.Response(200, json=_payload(utterances=[_utterance(0, "Hi")]))

    settings = Settings(deepgram_api_key="dg_test_key")
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = DeepgramTranscriptionAdapter(settings, client=client)

    await adapter.transcribe(b"fake audio", "meeting.mp3")

    assert seen["params"]["diarize"] == "true"
    assert seen["params"]["utterances"] == "true"
    assert seen["params"]["detect_language"] == "true"
    assert seen["auth"] == "Token dg_test_key"
    await client.aclose()


@pytest.mark.asyncio
async def test_explicit_language_replaces_detection():
    seen: dict = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["params"] = dict(request.url.params)
        return httpx.Response(200, json=_payload(utterances=[_utterance(0, "Hola")]))

    settings = Settings(deepgram_api_key="k", deepgram_language="es")
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = DeepgramTranscriptionAdapter(settings, client=client)

    await adapter.transcribe(b"audio", "a.wav")

    assert seen["params"]["language"] == "es"
    assert "detect_language" not in seen["params"]
    await client.aclose()


@pytest.mark.asyncio
async def test_persistent_failure_degrades_instead_of_killing_the_meeting():
    """A meeting with no transcript can be reprocessed; a dead worker cannot."""
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="upstream on fire")

    settings = Settings(deepgram_api_key="k", deepgram_max_retries=0)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = DeepgramTranscriptionAdapter(settings, client=client)

    result = await adapter.transcribe(b"audio", "a.wav")

    assert result.transcript == ""
    assert result.segments == []
    await client.aclose()


@pytest.mark.asyncio
async def test_a_transient_failure_is_retried():
    calls = {"n": 0}

    async def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(503, text="try again")
        return httpx.Response(200, json=_payload(utterances=[_utterance(0, "Recovered.")]))

    settings = Settings(deepgram_api_key="k", deepgram_max_retries=2)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = DeepgramTranscriptionAdapter(settings, client=client)

    result = await adapter.transcribe(b"audio", "a.wav")

    assert calls["n"] == 2
    assert "Recovered." in result.transcript
    await client.aclose()


# --------------------------------------------------------------------------- #
# Factory wiring
# --------------------------------------------------------------------------- #

def test_transcription_provider_is_independent_of_the_llm():
    """Deepgram speech + mock analysis: real audio path, no LLM spend."""
    from app.providers.factory import AiProviderFactory
    from app.providers.mock_adapter import MockLlmAdapter

    settings = Settings(
        ai_provider="mock", transcription_provider="deepgram", deepgram_api_key="k"
    )
    assert isinstance(
        AiProviderFactory.create_transcription(settings), DeepgramTranscriptionAdapter
    )
    assert isinstance(AiProviderFactory.create_llm(settings), MockLlmAdapter)


def test_auto_follows_the_ai_provider():
    from app.providers.factory import AiProviderFactory
    from app.providers.mock_adapter import MockTranscriptionAdapter

    # Default for every deployment that predates this setting.
    settings = Settings(ai_provider="mock", transcription_provider="auto")
    assert isinstance(
        AiProviderFactory.create_transcription(settings), MockTranscriptionAdapter
    )
