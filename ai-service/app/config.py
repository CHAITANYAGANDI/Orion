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

    # --- Spring internal callback ---
    spring_callback_url: str = "http://localhost:8080"
    recallix_internal_token: str = "dev-internal-token"

    # --- AI provider selection ---
    ai_provider: AiProvider = "mock"

    # --- OpenAI ---
    openai_api_key: str | None = None
    openai_transcribe_model: str = "whisper-1"
    openai_chat_model: str = "gpt-4o-mini"
    openai_embed_model: str = "text-embedding-3-small"
    openai_timeout_seconds: float = 60.0
    openai_max_retries: int = 2

    # --- RAG / pgvector ---
    # 1536 = OpenAI text-embedding-3-small; the mock embedder matches this dim.
    embed_dim: int = 1536
    rag_top_k: int = 4
    rag_chunk_chars: int = 700
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
