"""Ports (abstract base classes) for the AI provider strategy.

Concrete adapters (OpenAI, Mock) implement these. Application code depends only
on the ports — the factory decides which adapter to wire in.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from app.schemas import (
    ActionItem,
    DraftEmailRequest,
    DraftEmailResponse,
    SummaryResponse,
    SummaryTemplate,
    TranscriptResponse,
)


class TranscriptionPort(ABC):
    """Speech-to-text port (Whisper-style)."""

    @abstractmethod
    async def transcribe(
        self, audio: bytes, filename: str, vocabulary: list[str] | None = None
    ) -> TranscriptResponse:
        """Transcribe raw audio bytes into text + segments.

        `vocabulary` carries the user's boosting hints — product names, people,
        jargon, acronyms. They raise the probability of a term being recognised
        without forcing it, so adding "Kubernetes" makes it more likely to be
        heard and does not rewrite "coordinates" into it. Adapters whose
        provider cannot express boosting ignore the argument.

        Optional with a default so existing callers and tests are unaffected.
        """
        raise NotImplementedError


class LlmPort(ABC):
    """LLM port for summarization and structured extraction.

    `language` is the ISO-639-1 code the transcription step detected. A brief
    about a Spanish meeting should be written in Spanish — an English summary
    of a Spanish conversation is useless to the person who was in the room.
    It defaults to English so existing callers and tests are unaffected.

    Note that `sourceSentence` is exempt: it is a verbatim quote and must stay
    in whatever language it was spoken.
    """

    @abstractmethod
    async def summarize(
        self,
        transcript: str,
        language: str = "en",
        *,
        duration_seconds: float | None = None,
        speaker_count: int | None = None,
        template: SummaryTemplate | None = None,
    ) -> SummaryResponse:
        """Summarize a transcript.

        `duration_seconds` and `speaker_count` are facts about the recording
        that the transcript text cannot carry — how long the meeting ran and
        how many people spoke. They are optional because a caller with only
        loose text (the bare /ai/summarize endpoint) has neither.

        `template` decides which sections the summary contains; None means the
        built-in General shape.
        """
        raise NotImplementedError

    @abstractmethod
    async def extract_action_items(
        self, transcript: str, language: str = "en"
    ) -> list[ActionItem]:
        raise NotImplementedError

    @abstractmethod
    async def answer(self, question: str, context: list[str]) -> str:
        """Answer a question grounded ONLY in the provided context passages."""
        raise NotImplementedError

    @abstractmethod
    async def translate(self, text: str, target_language: str) -> str:
        """Translate text into the target language, preserving meaning."""
        raise NotImplementedError

    @abstractmethod
    async def draft_followup_email(self, brief: DraftEmailRequest) -> DraftEmailResponse:
        """Write a recap email the user can send without editing.

        Grounded strictly in the supplied brief — a follow-up that invents a
        commitment is worse than no follow-up at all, because the user forwards
        it before reading it closely.
        """
        raise NotImplementedError


class EmbeddingPort(ABC):
    """Embedding port for RAG retrieval (text -> fixed-dim vectors)."""

    @abstractmethod
    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Return one embedding vector per input text (all `embed_dim` long)."""
        raise NotImplementedError
