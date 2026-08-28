"""The exact JSON Orion asks AssemblyAI for.

Split from tests/test_assemblyai.py, which is about reading the response. This
is about writing the request, and it is worth its own file because the failure
mode is invisible: the provider accepts most wrong combinations and quietly
ignores the field, so a boost that is never applied looks exactly like a boost
that is. One combination it does *not* ignore returns a 400, and that one is
asserted here by name.

Every expectation below was checked against the live API before it was written
down. Where the published documentation disagreed, the API won — see
docs/transcription-audit.md §6.
"""

from __future__ import annotations

import httpx
import pytest

from app.config import Settings
from app.providers.assemblyai_adapter import (
    AssemblyAiTranscriptionAdapter,
    TranscriptionConfigurationError,
    TranscriptionRequest,
    build_request,
    keyterms_limit_for,
    supports_prompt,
)
from app.schemas import MeetingContext as MeetingContextSchema
from app.schemas import SpeakerExpectation
from app.transcription_context import (
    KEYTERMS_MAX_UNIVERSAL_2,
    KEYTERMS_MAX_UNIVERSAL_3,
    MeetingContext,
)

U3 = ["universal-3-5-pro", "universal-2"]
U3_ONLY = ["universal-3-5-pro"]
U2_ONLY = ["universal-2"]
URL = "https://storage.example/recording.webm"


def _request(**kwargs) -> TranscriptionRequest:
    return TranscriptionRequest(**kwargs)


# --- what is always true ----------------------------------------------------- #
def test_diarization_and_its_prerequisite_are_always_on():
    body = build_request(URL, U3, _request())
    assert body["speaker_labels"] is True
    # Not decoration: the provider refuses speaker_labels without punctuate.
    assert body["punctuate"] is True
    assert body["format_text"] is True
    assert body["audio_url"] == URL
    assert body["speech_models"] == U3


def test_no_foreign_diarization_parameters_leak_into_this_request():
    """AssemblyAI asks for diarization in exactly two fields, and no others.

    `diarize_model` and `diarize` belonged to the Deepgram adapter, which has
    since been deleted. The assertion outlives it on purpose: AssemblyAI rejects
    a request carrying parameters it does not know, and "a field from somewhere
    else drifted in" is a mistake that survives the adapter that introduced it.
    """
    body = build_request(URL, U3, _request())
    assert "diarize_model" not in body
    assert "diarize" not in body
    # Still exactly the two fields diarization has ever needed here.
    assert body["speaker_labels"] is True
    assert body["punctuate"] is True


# --- language ---------------------------------------------------------------- #
def test_a_stated_language_is_sent_and_detection_is_not():
    body = build_request(URL, U3, _request(language="es"))
    assert body["language_code"] == "es"
    # Mutually exclusive: sending both is a 400.
    assert "language_detection" not in body


def test_no_language_asks_the_provider_to_detect():
    body = build_request(URL, U3, _request())
    assert body["language_detection"] is True
    assert "language_code" not in body


def test_the_account_setting_beats_the_deployment_default():
    body = build_request(URL, U3, _request(language="fr"), configured_language="en")
    assert body["language_code"] == "fr"


def test_the_deployment_default_is_used_when_the_account_says_nothing():
    body = build_request(URL, U3, _request(), configured_language="en")
    assert body["language_code"] == "en"


# --- keyterms vs word_boost -------------------------------------------------- #
#
# The terms themselves used to come from the account's custom vocabulary. That
# feature is gone, so `organisations` is the only remaining source and nothing
# fills it on the enqueue path -- which makes "no boosting field at all" the
# ordinary case rather than the empty one. Both channels are still exercised
# here because which one is sent is a fact about the model, not about us, and
# sending the wrong one fails silently.
def test_universal_3_gets_keyterms_and_never_the_superseded_parameter():
    body = build_request(URL, U3, _request(context=MeetingContext(organisations=["pgvector"])))
    assert body["keyterms_prompt"] == ["pgvector"]
    assert "word_boost" not in body
    assert "boost_param" not in body


def test_universal_2_alone_still_gets_word_boost():
    """Not because keyterms would be rejected -- the older model simply has the
    older channel, and the fallback exists for languages the primary cannot do."""
    body = build_request(
        URL, U2_ONLY, _request(context=MeetingContext(organisations=["pgvector"]))
    )
    assert body["word_boost"] == ["pgvector"]
    assert body["boost_param"] == "high"
    assert "keyterms_prompt" not in body


def test_no_context_sends_no_boosting_field_at_all():
    body = build_request(URL, U3, _request())
    assert "keyterms_prompt" not in body
    assert "word_boost" not in body


def test_the_keyterm_ceiling_follows_the_weakest_model_in_the_chain():
    """A job may land on the fallback. A thousand terms sent to a request that
    runs on universal-2 is a refusal for a reason nobody logged."""
    assert keyterms_limit_for(U3_ONLY) == KEYTERMS_MAX_UNIVERSAL_3
    assert keyterms_limit_for(U2_ONLY) == KEYTERMS_MAX_UNIVERSAL_2
    assert keyterms_limit_for(U3) == KEYTERMS_MAX_UNIVERSAL_2
    assert keyterms_limit_for([]) == KEYTERMS_MAX_UNIVERSAL_2


def test_the_terms_actually_sent_respect_that_ceiling():
    many = MeetingContext(organisations=[f"term{i}" for i in range(2000)])
    body = build_request(URL, U3_ONLY, _request(context=many))
    assert len(body["keyterms_prompt"]) == KEYTERMS_MAX_UNIVERSAL_3

    body = build_request(URL, U2_ONLY, _request(context=many))
    assert len(body["word_boost"]) == KEYTERMS_MAX_UNIVERSAL_2


# --- prompt ------------------------------------------------------------------ #
def test_the_prompt_goes_only_to_a_model_that_takes_one():
    assert supports_prompt(U3_ONLY) is True
    assert supports_prompt(U3) is True
    assert supports_prompt(U2_ONLY) is False
    assert supports_prompt([]) is False

    context = MeetingContext(title="Sprint review", meeting_type="Standup")
    assert "prompt" in build_request(URL, U3, _request(context=context))
    assert "prompt" not in build_request(URL, U2_ONLY, _request(context=context))


def test_a_meeting_nothing_is_known_about_carries_no_prompt():
    assert "prompt" not in build_request(URL, U3, _request())


# --- speaker constraints ------------------------------------------------------ #
def test_auto_sends_no_constraint_whatsoever():
    """The default, and the one that must stay the default. An exact count is a
    hard constraint at the provider: wrong, it splits two people into four."""
    body = build_request(URL, U3, _request(speakers=SpeakerExpectation()))
    assert "speakers_expected" not in body
    assert "speaker_options" not in body


def test_an_exact_count_is_sent_as_speakers_expected():
    body = build_request(URL, U3, _request(
        speakers=SpeakerExpectation(mode="exact", exact=2)))
    assert body["speakers_expected"] == 2
    assert "speaker_options" not in body


def test_a_range_is_sent_as_speaker_options():
    body = build_request(URL, U3, _request(
        speakers=SpeakerExpectation(mode="range", minimum=2, maximum=4)))
    assert body["speaker_options"] == {
        "min_speakers_expected": 2, "max_speakers_expected": 4
    }
    assert "speakers_expected" not in body


def test_the_two_speaker_fields_are_never_sent_together():
    """The provider answers that pairing with
    HTTP 400 "Both speaker_options and speakers_expected can not be used in the
    same request." Verified against the live API."""
    body = build_request(URL, U3, _request(speakers=SpeakerExpectation(
        mode="exact", exact=3, minimum=2, maximum=4)))
    assert ("speakers_expected" in body) != ("speaker_options" in body)


def test_a_half_open_range_sends_only_the_half_it_has():
    body = build_request(URL, U3, _request(
        speakers=SpeakerExpectation(mode="range", minimum=2)))
    assert body["speaker_options"] == {"min_speakers_expected": 2}


@pytest.mark.parametrize("bad", [
    SpeakerExpectation(mode="exact", exact=0),
    SpeakerExpectation(mode="exact", exact=99),
    SpeakerExpectation(mode="exact"),
    SpeakerExpectation(mode="range"),
])
def test_an_impossible_constraint_becomes_auto_rather_than_a_refused_job(bad):
    body = build_request(URL, U3, _request(speakers=bad))
    assert "speakers_expected" not in body
    assert "speaker_options" not in body


def test_a_backwards_range_is_straightened_rather_than_sent_backwards():
    body = build_request(URL, U3, _request(
        speakers=SpeakerExpectation(mode="range", minimum=5, maximum=2)))
    assert body["speaker_options"] == {
        "min_speakers_expected": 2, "max_speakers_expected": 5
    }


# --- multichannel -------------------------------------------------------------- #
def test_multichannel_is_off_unless_asked_for():
    """A stereo recording of a room has everybody on both channels. Reading
    channels as speakers there invents two people out of one."""
    assert "multichannel" not in build_request(URL, U3, _request())
    assert build_request(URL, U3, _request(multichannel=True))["multichannel"] is True


# --- from the event ------------------------------------------------------------ #
def test_the_event_shape_maps_onto_the_request():
    request = TranscriptionRequest.from_event(
        language="en",
        context=MeetingContextSchema(
            title="Sprint review", project="Orion",
            meeting_type="Engineering sprint review",
            organisations=["Acme"],
        ),
        speakers=SpeakerExpectation(mode="range", minimum=2, maximum=3),
        multichannel=False,
        audio_url=URL,
    )
    body = build_request(request.audio_url or "", U3, request)
    assert body["language_code"] == "en"
    assert body["keyterms_prompt"] == ["Acme"]
    assert "Orion" in body["prompt"]
    assert body["speaker_options"]["max_speakers_expected"] == 3


def test_an_event_with_no_context_at_all_still_builds():
    """Events published before these fields existed still have to process."""
    request = TranscriptionRequest.from_event(
        language=None, context=None, speakers=None,
    )
    body = build_request(URL, U3, request)
    assert body["language_detection"] is True
    assert "prompt" not in body


# --- what happens when the provider says no ------------------------------------ #
def _adapter(handler) -> AssemblyAiTranscriptionAdapter:
    settings = Settings(
        assemblyai_api_key="test-key",
        assemblyai_max_retries=1,
        assemblyai_poll_interval_seconds=0.0,
        assemblyai_timeout_seconds=5.0,
    )
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return AssemblyAiTranscriptionAdapter(settings, client=client)


@pytest.mark.asyncio
async def test_a_refused_request_fails_the_meeting_rather_than_emptying_it():
    """The old behaviour swallowed every error into an empty transcript, so a
    malformed request produced a meeting that looked recorded in silence."""
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(400, json={"error": "Both speaker_options and "
                                                  "speakers_expected can not be used"})

    with pytest.raises(TranscriptionConfigurationError) as raised:
        await _adapter(handler).transcribe(
            b"", "a.webm", request=TranscriptionRequest(audio_url=URL))

    assert "speakers_expected" in str(raised.value)
    # Submitted once. Retrying a refused request refuses it again.
    assert calls.count("/v2/transcript") == 1


@pytest.mark.asyncio
async def test_a_transport_failure_still_degrades_instead_of_crashing_the_worker():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    result = await _adapter(handler).transcribe(
        b"", "a.webm", request=TranscriptionRequest(audio_url=URL))
    assert result.transcript == ""


@pytest.mark.asyncio
async def test_a_url_is_handed_over_instead_of_uploading_the_file_twice():
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.path == "/v2/transcript":
            return httpx.Response(200, json={"id": "job_1"})
        return httpx.Response(200, json={
            "status": "completed", "language_code": "en", "text": "Hi.",
            "utterances": [{"speaker": "A", "text": "Hi.", "start": 0, "end": 500}],
        })

    await _adapter(handler).transcribe(
        b"bytes-that-should-not-move", "a.webm",
        request=TranscriptionRequest(audio_url=URL))

    assert "/v2/upload" not in seen


@pytest.mark.asyncio
async def test_without_a_url_the_bytes_are_uploaded_as_before():
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.path == "/v2/upload":
            return httpx.Response(200, json={"upload_url": "https://cdn/x"})
        if request.url.path == "/v2/transcript":
            return httpx.Response(200, json={"id": "job_1"})
        return httpx.Response(200, json={"status": "completed", "text": "Hi."})

    await _adapter(handler).transcribe(b"audio", "a.webm")
    assert "/v2/upload" in seen


@pytest.mark.asyncio
async def test_a_positional_language_still_reaches_the_provider():
    """Three adapters and a dozen tests pass it positionally. It must not be
    dropped in favour of an empty field on a default-constructed request.

    There was a `vocabulary` argument beside it, asserted here for the same
    reason. Custom vocabulary was removed, and so was the parameter."""
    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v2/upload":
            return httpx.Response(200, json={"upload_url": URL})
        if request.url.path == "/v2/transcript":
            import json
            bodies.append(json.loads(request.content))
            return httpx.Response(200, json={"id": "job_1"})
        return httpx.Response(200, json={"status": "completed", "text": "Hi."})

    await _adapter(handler).transcribe(b"audio", "a.webm", "de")
    assert bodies[0]["language_code"] == "de"


# --- the audio the provider could not reach ---------------------------------- #
#
# A regression, and a bad one: handing over a URL signed against the *internal*
# storage endpoint produced a job the provider accepted and then could not
# fetch. Three retries later the meeting had an empty transcript and nothing on
# screen said why. See docs/transcription-audit.md and app/storage.py.
@pytest.mark.asyncio
async def test_an_unreachable_url_is_named_rather_than_retried_into_silence():
    from app.providers.assemblyai_adapter import AudioUnreachableError

    polls = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v2/transcript":
            return httpx.Response(200, json={"id": "job_1"})
        polls.append(request.url.path)
        return httpx.Response(200, json={
            "status": "error",
            "error": "Download error, unable to download "
                     "http://minio:9000/orion/x.webm: could not connect to the host.",
        })

    with pytest.raises(AudioUnreachableError):
        await _adapter(handler).transcribe(
            b"", "a.webm", request=TranscriptionRequest(audio_url="http://minio:9000/x"))

    # Submitted once. The URL is no more reachable on the second attempt, and
    # the old behaviour was three of them followed by an empty transcript.
    assert len(polls) == 1


@pytest.mark.asyncio
async def test_an_ordinary_job_failure_is_still_just_a_failure():
    # Narrow on purpose: a false positive here would re-upload a whole
    # recording after a failure that had nothing to do with fetching it.
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v2/transcript":
            return httpx.Response(200, json={"id": "job_1"})
        return httpx.Response(200, json={"status": "error", "error": "Internal error"})

    result = await _adapter(handler).transcribe(
        b"", "a.webm", request=TranscriptionRequest(audio_url="https://ok/x"))
    assert result.transcript == ""
