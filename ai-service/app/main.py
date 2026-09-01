"""FastAPI application entrypoint.

Wires the provider factory -> pipeline -> routers, and starts the resilient
Kafka worker as a lifespan background task.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.callback import SpringCallbackClient
from app.config import get_settings
from app.kafka_worker import KafkaWorker
from app.pipeline import Pipeline
from app.providers.factory import AiProviderFactory
from app.rag import RagService
from app.rediarize import SpeakerRefiner
from app.routers import ai as ai_router
from app.schemas import HealthResponse
from app.speaker_identity import SpeakerIdentityService
from app.transcode import Mp3Transcoder

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("ai-service")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()

    # Build provider adapters + pipeline (Strategy + Factory + Adapter).
    transcription = AiProviderFactory.create_transcription(settings)
    llm = AiProviderFactory.create_llm(settings)
    embedder = AiProviderFactory.create_embedding(settings)
    # Second-guesses the provider's turn boundaries against the audio. Loads
    # nothing until a meeting actually has a suspiciously long turn in it, and
    # degrades to "leave the provider's segmentation alone" without the
    # embedder.
    refiner = SpeakerRefiner()
    # No acoustic second opinion. The only implementation was pyannote and it
    # was removed after being benchmarked -- docs/diarization.md section 12 has
    # the numbers. The seam it plugged into is still there and still tested
    # (app/reconcile.py, app/reattribute.py), so a future diarizer is a
    # constructor argument rather than a rewrite.
    pipeline = Pipeline(transcription, llm, refiner, diarizer=None)
    app.state.pipeline = pipeline

    # RAG service (pgvector). Indexes transcripts + answers grounded questions.
    rag = RagService(settings, embedder, llm)
    await rag.start()
    app.state.rag = rag

    # Speaker identification. Shares the RAG pool rather than opening a second
    # one, so there is exactly one place where `app.user_id` is stamped on a
    # connection -- which matters more for voice templates than for anything
    # else here. Nothing is loaded eagerly: the embedding model costs seconds
    # and ~80MB, and an ai-service that never identifies a speaker never pays.
    speakers = SpeakerIdentityService(settings, rag)
    app.state.speakers = speakers

    # MP3 export. Holds no resources -- ffmpeg is a subprocess and the object
    # store is asked per call -- but it must be one object per process, because
    # the thing that stops two Export clicks becoming two conversions of the
    # same recording is state on it.
    app.state.transcoder = Mp3Transcoder(settings)

    # Start the Kafka worker (resilient; never crashes on broker outage).
    # It indexes each processed transcript into pgvector for the chat feature.
    callback = SpringCallbackClient(settings)
    worker = KafkaWorker(settings, pipeline, callback, rag)
    worker.start()
    app.state.kafka_worker = worker

    logger.info(
        "ai-service started (provider=%s, rag=%s, speaker-id=%s, refine=%s).",
        settings.ai_provider,
        rag.enabled,
        "off" if speakers.unavailable_reason() else "ready",
        "ready" if refiner.available else "off",
    )
    try:
        yield
    finally:
        await worker.stop()
        await rag.stop()
        logger.info("ai-service stopped.")


app = FastAPI(title="Reverie AI Service", version="0.1.0", lifespan=lifespan)
app.include_router(ai_router.router)


@app.get("/health", response_model=HealthResponse, tags=["health"])
async def health() -> HealthResponse:
    settings = get_settings()
    return HealthResponse(status="ok", provider=settings.ai_provider)
