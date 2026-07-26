"""Ports (abstract base classes) for the AI provider strategy.

Concrete adapters (OpenAI, Mock) implement these. Application code depends only
on the ports — the factory decides which adapter to wire in.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from app.schemas import (
    ActionItem,
    CommitmentVerdict,
    Decision,
    DecisionRelation,
    Risk,
    SummaryResponse,
    TranscriptResponse,
)


class TranscriptionPort(ABC):
    """Speech-to-text port (Whisper-style)."""

    @abstractmethod
    async def transcribe(self, audio: bytes, filename: str) -> TranscriptResponse:
        """Transcribe raw audio bytes into text + segments."""
        raise NotImplementedError


class LlmPort(ABC):
    """LLM port for summarization and structured extraction."""

    @abstractmethod
    async def summarize(self, transcript: str) -> SummaryResponse:
        raise NotImplementedError

    @abstractmethod
    async def extract_action_items(self, transcript: str) -> list[ActionItem]:
        raise NotImplementedError

    @abstractmethod
    async def extract_decisions(self, transcript: str) -> list[Decision]:
        raise NotImplementedError

    @abstractmethod
    async def extract_risks(self, transcript: str) -> list[Risk]:
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
    async def judge_commitment(
        self, commitment: str, owner: str | None, passages: list[str]
    ) -> CommitmentVerdict:
        """Decide what a later meeting says about an earlier promise.

        `passages` are excerpts from ONE later meeting. Returns NO_EVIDENCE
        unless the passages actually speak to the commitment — silence is the
        expected outcome for most meetings and must not be over-read.
        """
        raise NotImplementedError

    @abstractmethod
    async def compare_decisions(self, earlier: str, later: str) -> DecisionRelation:
        """Adjudicate two semantically-close decisions made at different times.

        Returns UNRELATED when the pair merely shares vocabulary — retrieval
        finds candidates, this decides whether they actually conflict.
        """
        raise NotImplementedError


class EmbeddingPort(ABC):
    """Embedding port for RAG retrieval (text -> fixed-dim vectors)."""

    @abstractmethod
    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Return one embedding vector per input text (all `embed_dim` long)."""
        raise NotImplementedError
