"""Factory that selects provider adapters from `AI_PROVIDER`."""

from __future__ import annotations

import logging

from app.config import Settings
from app.providers.mock_adapter import (
    MockEmbeddingAdapter,
    MockLlmAdapter,
    MockTranscriptionAdapter,
)
from app.providers.ports import EmbeddingPort, LlmPort, TranscriptionPort

logger = logging.getLogger("ai-service.factory")


class AiProviderFactory:
    """Creates the transcription + LLM ports for the configured provider."""

    @staticmethod
    def create_transcription(settings: Settings) -> TranscriptionPort:
        # Transcription is selected independently of the LLM so speech and
        # analysis can come from different vendors — Deepgram diarizes, which
        # Whisper does not. "auto" keeps the original behaviour of following
        # `ai_provider`.
        choice = settings.transcription_provider
        if choice == "auto":
            choice = settings.ai_provider

        if choice == "assemblyai":
            from app.providers.assemblyai_adapter import AssemblyAiTranscriptionAdapter

            logger.info(
                "Using AssemblyAI transcription adapter (%s, diarization on).",
                settings.assemblyai_model,
            )
            return AssemblyAiTranscriptionAdapter(settings)

        if choice == "deepgram":
            from app.providers.deepgram_adapter import DeepgramTranscriptionAdapter

            logger.info(
                "Using Deepgram transcription adapter (%s, diarization on).",
                settings.deepgram_model,
            )
            return DeepgramTranscriptionAdapter(settings)

        if choice == "openai":
            # Imported lazily so the mock path never requires the OpenAI client.
            from app.providers.openai_adapter import OpenAiTranscriptionAdapter

            logger.info("Using OpenAI transcription adapter (%s).", settings.openai_transcribe_model)
            return OpenAiTranscriptionAdapter(settings)

        logger.info("Using mock transcription adapter.")
        return MockTranscriptionAdapter()

    @staticmethod
    def create_diarization(settings: Settings):
        """An acoustic diarizer allowed to overrule the provider, or None.

        None is the default and the common case. Returning None rather than a
        no-op port is deliberate: the pipeline then skips decoding the audio a
        second time, which is not free on a long recording.

        Import is local so that a deployment with ``diarization_provider="none"``
        never imports pyannote — and therefore never pays for it, and does not
        need it installed.
        """
        choice = (settings.diarization_provider or "none").strip().lower()
        if choice in ("", "none", "off"):
            return None
        if choice != "pyannote":
            logger.warning("Unknown diarization_provider %r; keeping the provider's "
                           "speaker labels.", choice)
            return None

        from app.providers.pyannote_diarizer import PyannoteDiarizer

        diarizer = PyannoteDiarizer(cache_dir=settings.pyannote_cache)
        reason = diarizer.unavailable_reason()
        if reason:
            # Configured but unusable. Loud, because somebody asked for this and
            # is entitled to know it is not happening -- but not fatal, because
            # a missing model must not fail a transcript.
            logger.warning("Diarization provider 'pyannote' is configured but "
                           "unavailable (%s); keeping the provider's labels.", reason)
            return None
        logger.info("Diarization provider: pyannote (%s).", diarizer.name)
        return diarizer

    @staticmethod
    def create_llm(settings: Settings) -> LlmPort:
        if settings.ai_provider == "openai":
            from app.providers.openai_adapter import OpenAiLlmAdapter

            logger.info("Using OpenAI LLM adapter (%s).", settings.openai_chat_model)
            return OpenAiLlmAdapter(settings)
        logger.info("Using mock LLM adapter.")
        return MockLlmAdapter()

    @staticmethod
    def create_embedding(settings: Settings) -> EmbeddingPort:
        if settings.ai_provider == "openai":
            from app.providers.openai_adapter import OpenAiEmbeddingAdapter

            logger.info("Using OpenAI embedding adapter (%s).", settings.openai_embed_model)
            return OpenAiEmbeddingAdapter(settings)
        logger.info("Using mock embedding adapter (dim=%d).", settings.embed_dim)
        return MockEmbeddingAdapter(dim=settings.embed_dim)
