"""Application configuration via pydantic-settings.

All values are read from environment variables (see docker-compose.yml
`ai-service.environment`). Sensible defaults let the service boot in mock mode
with no external dependencies.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

AiProvider = Literal["mock", "openai"]

# Transcription is chosen separately from the LLM. Whisper cannot diarize, so
# the useful real-world combination is Deepgram for speech and OpenAI for
# analysis — and during development, Deepgram for speech with the mock LLM,
# which costs nothing and still exercises the real audio path.
# "auto" follows `ai_provider`, which is what every existing deployment expects.
TranscriptionProvider = Literal["auto", "mock", "openai", "deepgram"]


class Settings(BaseSettings):
    """Runtime configuration for the ai-service."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- Kafka ---
    kafka_bootstrap_servers: str = "localhost:9092"
    kafka_consumer_group: str = "ai-service"
    kafka_topic_meeting_uploaded: str = "meeting_uploaded"
    # Local Kafka listens without auth. A managed broker needs SASL_SSL plus an
    # API key/secret; the credentials are only applied when the protocol asks
    # for them, so leaving these unset keeps the local path untouched.
    kafka_security_protocol: str = "PLAINTEXT"
    kafka_sasl_mechanism: str = "PLAIN"
    kafka_sasl_username: str | None = None
    kafka_sasl_password: str | None = None

    # --- Spring internal callback ---
    spring_callback_url: str = "http://localhost:8080"
    recallix_internal_token: str = "dev-internal-token"

    # --- AI provider selection ---
    ai_provider: AiProvider = "mock"
    transcription_provider: TranscriptionProvider = "auto"

    # --- Deepgram (speech-to-text with speaker diarization) ---
    deepgram_api_key: str | None = None
    deepgram_model: str = "nova-3"
    # Blank means auto-detect, which is what a multilingual user wants. Set an
    # ISO code (e.g. "es") when every meeting is in one language — detection is
    # good but not free of mistakes, and a wrong guess corrupts the transcript.
    deepgram_language: str = ""
    # Transcription of a long recording is a single long request; Deepgram runs
    # faster than real time, but an hour of audio still needs generous headroom.
    deepgram_timeout_seconds: float = 300.0
    deepgram_max_retries: int = 2

    # --- OpenAI ---
    openai_api_key: str | None = None
    openai_transcribe_model: str = "whisper-1"
    # Writes the summary and attributes action items — the two passes needing
    # judgement, and the ones a user reads. `gpt-5.6-sol` is the stronger
    # sibling if the notes still read thin; it costs about 2.5x more.
    openai_chat_model: str = "gpt-5.6-terra"
    # Entity listing, decisions and risks: structured JSON against an explicit
    # schema, which the cost-optimized model handles well for roughly a tenth
    # of the price. Point this at `openai_chat_model` to put everything back on
    # one model.
    openai_extraction_model: str = "gpt-5.6-luna"
    openai_embed_model: str = "text-embedding-3-small"
    openai_timeout_seconds: float = 60.0
    openai_max_retries: int = 2
    # Left unset, so the parameter is not sent at all. Extraction wants
    # temperature 0 for repeatable output, but the current models accept only
    # their default and reject an explicit 0 with a 400 — which surfaced as an
    # entirely empty brief. Set a number here only for a model known to allow
    # it.
    openai_temperature: float | None = None
    # How many chat calls may be in flight at once, counted per model. The
    # brief needs five passes over the same transcript, and on a small
    # tokens-per-minute allowance firing them together is refused outright.
    # Four lets the whole fan-out through, which the current models' limits
    # absorb comfortably; lower it if a 429 ever reappears in the logs.
    openai_max_concurrent_calls: int = 4

    # --- RAG / pgvector ---
    # 1536 = OpenAI text-embedding-3-small; the mock embedder matches this dim.
    embed_dim: int = 1536
    # Eight passages of ~1200 chars gives the model roughly 10k characters to
    # answer from. Four passages of 700 gave it under 3k — about half a page,
    # which is why answers used to miss things that were plainly said.
    rag_top_k: int = 8
    rag_chunk_chars: int = 1200
    # ~15%. Enough that a sentence cut by a boundary survives whole in the
    # neighbouring passage, without duplicating so much that retrieval returns
    # the same words several times over.
    rag_chunk_overlap_chars: int = 180
    # Workspace-wide chat spans many meetings, so it needs a wider net than the
    # single-meeting chat above.
    rag_workspace_top_k: int = 10
    rag_search_limit: int = 20
    # Semantic search dedupes to one hit per meeting after the ANN scan, and the
    # owner filter discards some candidates, so the inner scan fetches this
    # multiple of the requested limit to avoid under-filling the result.
    rag_search_overfetch: int = 8

    # --- Meeting Memory (commitment ledger + decision drift) ---
    # Passages of the new meeting shown to the LLM when judging one commitment.
    memory_evidence_k: int = 4
    # Prior decisions retrieved as drift candidates per new decision.
    memory_drift_candidates: int = 3
    # Cosine similarity floor before a decision pair is worth an LLM comparison.
    # Below this the pair is almost always unrelated and not worth the tokens.
    memory_drift_min_similarity: float = 0.72
    pg_host: str | None = None
    pg_port: int = 5432
    pg_database: str = "recallix"
    pg_user: str = "recallix"
    pg_password: str = "recallix"
    # "prefer" encrypts when the server offers it and falls back when it does
    # not, which is what the local container needs. A managed Postgres (Neon)
    # refuses unencrypted connections outright and wants "require".
    pg_sslmode: str = "prefer"

    # --- S3 / MinIO ---
    s3_endpoint: str | None = None
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_bucket: str = "recallix"
    s3_region: str = "us-east-1"

    # --- HTTP download ---
    download_timeout_seconds: float = 60.0

    # --- Alternative sources (YouTube links, PDF documents) ---
    # A 3-hour cap and a 200 MB cap between them exclude full conference
    # recordings that would blow the transcription budget on one upload.
    youtube_max_bytes: int = 200 * 1024 * 1024
    youtube_max_duration_seconds: int = 3 * 60 * 60
    # ~200k characters is roughly 50k tokens: long enough for real minutes,
    # short enough to stay inside a single analysis call.
    document_max_chars: int = 200_000


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance."""
    return Settings()
