"""The language a meeting is transcribed in.

Detection is the default and it is good. It is also wrong on exactly the
recordings people complain about — a two-minute voice note, a noisy first
minute, a standup held half in one language — and a wrong detection is not a
cosmetic label. The provider returns words in a language nobody spoke, the
summary is written in it, and nothing downstream repairs any of that.

So an account can say once what its meetings are in. These tests cover the two
places that setting can be silently dropped: the precedence rule where it meets
the deployment-wide default, and the walk from the Kafka event through the
pipeline to the provider. Both failures are quiet — the transcript still
arrives, just in the wrong language.
"""

from __future__ import annotations

import pytest

from app.pipeline import Pipeline
from app.providers.assemblyai_adapter import language_choice
from app.providers.mock_adapter import MockLlmAdapter
from app.schemas import MeetingUploadedEvent, TranscriptResponse


# --- the precedence rule ---------------------------------------------------- #
def test_no_setting_anywhere_means_detect():
    # None rather than "", because the adapter branches on it to choose between
    # `language_code` and `language_detection`.
    assert language_choice(None, "") is None
    assert language_choice("", None) is None


def test_the_deployment_default_applies_when_the_account_says_nothing():
    assert language_choice(None, "es") == "es"


def test_the_account_setting_beats_the_deployment_default():
    # The env var is what this Orion defaults to; the account setting is
    # somebody saying they know better about their own meetings.
    assert language_choice("ja", "es") == "ja"


def test_whitespace_is_not_a_choice():
    # A blank field on the settings page must read as "detect", not as a
    # language code made of spaces that the provider would reject.
    assert language_choice("   ", "es") == "es"
    assert language_choice("  ", "  ") is None


# --- the walk from the event to the provider -------------------------------- #
class _RecordingTranscriber:
    """Records what it was asked for, so the argument cannot go missing quietly."""

    def __init__(self) -> None:
        self.language: str | None = "not called"

    async def transcribe(self, audio, filename, language=None, **_):
        self.language = language
        return TranscriptResponse(transcript="Acordamos usar S3.", language="es", segments=[])


@pytest.mark.asyncio
async def test_the_pipeline_hands_the_language_to_the_provider():
    transcriber = _RecordingTranscriber()
    pipeline = Pipeline(transcriber, MockLlmAdapter())

    await pipeline.process("mtg_1", b"audio", "call.wav", None, None, None, "es")

    assert transcriber.language == "es"


@pytest.mark.asyncio
async def test_no_language_reaches_the_provider_as_none():
    transcriber = _RecordingTranscriber()
    pipeline = Pipeline(transcriber, MockLlmAdapter())

    await pipeline.process("mtg_1", b"audio", "call.wav")

    # Which the adapter reads as detect — the behaviour every job had before
    # the setting existed.
    assert transcriber.language is None


# --- the event ------------------------------------------------------------- #
def test_an_event_without_a_language_still_validates():
    # Events published before this field existed are still in the topic, and a
    # required field here would fail every one of them.
    event = MeetingUploadedEvent(meetingId="mtg_1", userId="usr_1")

    assert event.language is None


def test_the_event_carries_the_code_spring_resolved():
    event = MeetingUploadedEvent(meetingId="mtg_1", userId="usr_1", language="de")

    assert event.language == "de"
