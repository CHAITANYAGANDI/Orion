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


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance."""
    return Settings()
