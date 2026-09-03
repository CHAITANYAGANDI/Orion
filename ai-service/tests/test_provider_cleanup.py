"""What the Deepgram and pyannote removal must keep true.

Deleting a provider is easy to do incompletely. The failure that matters is not
a leftover file — it is a configuration value that still *looks* selectable,
so somebody sets `TRANSCRIPTION_PROVIDER=deepgram`, gets the mock transcriber
without an error, and finds out from the transcript.

So these tests assert the shape of the absence: the option cannot be chosen, the
deleted modules cannot be imported, the removed environment variables are not
required to start, and — the part that is easiest to break by accident — the
speaker stack that shares names with the deleted things is still entirely here.
"""

from __future__ import annotations

import importlib

import pytest

from app.config import Settings
from app.providers.factory import AiProviderFactory
from app.providers.mock_adapter import MockTranscriptionAdapter


# --- Deepgram is gone, and gone in a way that cannot be selected ------------ #

def test_assemblyai_is_still_what_the_deployment_selects():
    settings = Settings(transcription_provider="assemblyai", assemblyai_api_key="k")

    adapter = AiProviderFactory.create_transcription(settings)

    assert type(adapter).__name__ == "AssemblyAiTranscriptionAdapter"


def test_deepgram_is_not_a_value_the_settings_will_accept():
    # The important half. If the literal still admitted "deepgram", the factory
    # would fall through to the mock and transcribe a real meeting with a
    # scripted fixture -- silently, and only visible in the output.
    with pytest.raises(Exception):
        Settings(transcription_provider="deepgram")


def test_the_deepgram_adapter_is_not_importable():
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("app.providers.deepgram_adapter")


def test_no_deepgram_settings_survive():
    leftovers = [name for name in Settings.model_fields if "deepgram" in name.lower()]
    assert leftovers == []


# --- pyannote is gone, and nothing tries to reach it ------------------------ #

def test_the_pyannote_adapter_is_not_importable():
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("app.providers.pyannote_diarizer")


def test_there_is_no_diarization_provider_setting_left():
    leftovers = [
        name for name in Settings.model_fields
        if "diarization_provider" in name.lower() or "pyannote" in name.lower()
    ]
    assert leftovers == []


def test_the_factory_no_longer_offers_a_diarizer():
    assert not hasattr(AiProviderFactory, "create_diarization")


def test_importing_the_app_does_not_import_pyannote_or_deepgram():
    """The one that would catch a stale import left behind in a module.

    A dangling `from app.providers.pyannote_diarizer import ...` anywhere in the
    import graph fails here rather than at container start.
    """
    import sys

    for module in ("app.main", "app.pipeline", "app.providers.factory",
                   "app.reconcile",
                   "app.reattribute", "app.diarize_port"):
        importlib.import_module(module)

    assert not [m for m in sys.modules if "pyannote" in m or "deepgram" in m]


# --- the removed environment variables are not required to start ------------ #

def test_settings_load_without_any_of_the_removed_variables(monkeypatch):
    for removed in ("DEEPGRAM_API_KEY", "DEEPGRAM_MODEL", "DEEPGRAM_LANGUAGE",
                    "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "DIARIZATION_PROVIDER",
                    "PYANNOTE_CACHE"):
        monkeypatch.delenv(removed, raising=False)
    # Also cleared, so the default below is the code's rather than the shell's.
    monkeypatch.delenv("TRANSCRIPTION_PROVIDER", raising=False)
    monkeypatch.delenv("AI_PROVIDER", raising=False)

    settings = Settings()

    assert settings.transcription_provider == "auto"
    assert AiProviderFactory.create_transcription(settings) is not None


def test_the_mock_path_still_works_with_no_keys_at_all():
    # What `docker run` with no environment does.
    adapter = AiProviderFactory.create_transcription(Settings(ai_provider="mock"))
    assert isinstance(adapter, MockTranscriptionAdapter)


# --- and the speaker stack, which shares vocabulary with what was deleted --- #

def test_speechbrain_ecapa_speaker_identification_is_still_here():
    """The whole point of doing this audit rather than a name-based sweep.

    "Hugging Face" appears in the deleted pyannote code AND in the speaker
    embedder that is still in use -- SpeechBrain fetches ECAPA from the Hub.
    Removing one must not have taken the other.

    ECAPA now serves exactly one purpose: **cross-meeting** voice identity, the
    thing "Rematch speakers" runs on. The meeting-local refinement that used to
    share it was deleted in stage two, and stage three removes this too.
    """
    from app.providers.ecapa_embedder import (  # noqa: F401
        DEFAULT_MODEL_SOURCE,
        EcapaEmbedder,
        SpeakerEmbeddingUnavailable,
        decode_to_pcm,
        take_spans,
    )

    assert DEFAULT_MODEL_SOURCE == "speechbrain/spkrec-ecapa-voxceleb"
    assert EcapaEmbedder().dim == 192


def test_the_meeting_local_refiner_is_gone():
    # Deleted in stage two. It ran ECAPA over every meeting to second-guess the
    # provider's turn boundaries; the CPU, memory and image cost of carrying
    # torch for it was not repaid, and the production runs that motivated it
    # still mis-attributed the cases it was meant to fix.
    for module in ("app.rediarize", "app.regions"):
        with pytest.raises(ModuleNotFoundError):
            importlib.import_module(module)


def test_the_voice_matching_settings_are_gone():
    # They configured cross-meeting voice identity, removed in stage 3A. A
    # setting whose only consumer has been deleted is the exact failure this
    # file exists for: it still looks selectable and does nothing.
    settings = Settings()

    assert [n for n in Settings.model_fields if "speaker" in n.lower()] == [
        "speaker_naming_enabled"]
    assert settings.speaker_naming_enabled is True


def test_the_reconciliation_seam_is_still_wired_even_with_no_diarizer():
    """Kept deliberately, and asserted so the decision is visible.

    Nothing supplies a diarizer today, so none of this runs. It is retained
    because it is the whole of what a future diarizer would plug into, and
    because it is a pure function of times that its own tests still cover.
    """
    from app.pipeline import Pipeline
    from app.reconcile import assign  # noqa: F401
    from app.reattribute import reattribute  # noqa: F401

    pipeline = Pipeline(MockTranscriptionAdapter(), llm=None, diarizer=None)

    assert pipeline._diarizer is None
