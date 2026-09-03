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
from app.routers import ai as ai_router
from app.schemas import HealthResponse
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
    # No acoustic stage of any kind in the normal meeting pipeline.
    #
    # There were two. `SpeakerRefiner` second-guessed the provider's turn
    # boundaries using local ECAPA embeddings of every meeting. It was taken
    # out of this path in stage one and deleted in stage two: the CPU, memory,
    # image size and cold-start cost of carrying torch and speechbrain did not
    # pay for itself, and the production runs it was built to fix still
    # mis-attributed the turns in question.
    #
    # The other was pyannote, removed earlier after being benchmarked --
    # docs/diarization.md section 12 has the numbers. Its seam
    # (app/reconcile.py, app/reattribute.py) is still here and still tested, so
    # a future diarizer is a constructor argument rather than a rewrite.
    #
    # AssemblyAI's own diarization now flows straight into `CanonicalSpeakers`,
    # which is where speakerKey has always come from and which never depended
    # on any of this.
    pipeline = Pipeline(transcription, llm, diarizer=None,
                        name_speakers=settings.speaker_naming_enabled)
    app.state.pipeline = pipeline

    # RAG service (pgvector). Indexes transcripts + answers grounded questions.
    rag = RagService(settings, embedder, llm)
    await rag.start()
    app.state.rag = rag

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
        "ai-service started (provider=%s, rag=%s).",
        settings.ai_provider,
        rag.enabled,
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
