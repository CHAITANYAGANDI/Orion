"""AI HTTP endpoints (api-contracts.md §4).

These expose each pipeline stage synchronously (useful for testing and the
Spring reprocess path). `/ai/process-meeting` downloads the audio and runs the
full pipeline, returning a MeetingBriefResult.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request

from app.config import Settings, get_settings
from app.insights import derive_insights
from app.pipeline import Pipeline
from app.rag import RagService
from app.schemas import (
    ActionItemsResponse,
    ChatRequest,
    ChatResponse,
    Citation,
    DraftEmailRequest,
    DraftEmailResponse,
    IndexRequest,
    IndexResponse,
    MeetingBriefResult,
    ProcessMeetingRequest,
    SemanticSearchHit,
    SemanticSearchRequest,
    SemanticSearchResponse,
    SummarizeRequest,
    SummaryResponse,
    SummaryTemplate,
    TranscribeRequest,
    TranscriptInput,
    TranscriptResponse,
    TranslateRequest,
    TranslateResponse,
    WorkspaceChatRequest,
)
from app.storage import fetch_audio
from app.templates import BUILT_IN, resolve

logger = logging.getLogger("ai-service.router.ai")

router = APIRouter(prefix="/ai", tags=["ai"])


def get_pipeline(request: Request) -> Pipeline:
    """Resolve the app-wide Pipeline built during startup."""
    return request.app.state.pipeline


def get_rag(request: Request) -> RagService:
    """Resolve the app-wide RagService built during startup."""
    return request.app.state.rag


@router.post("/transcribe", response_model=TranscriptResponse)
async def transcribe(
    body: TranscribeRequest,
    pipeline: Pipeline = Depends(get_pipeline),
    settings: Settings = Depends(get_settings),
) -> TranscriptResponse:
    audio, filename = await fetch_audio(
        settings, audio_url=body.audio_url, object_key=body.audio_path
    )
    return await pipeline.transcribe(audio, filename)


@router.get("/templates", response_model=list[SummaryTemplate])
async def list_templates() -> list[SummaryTemplate]:
    """The built-in templates, with the section instructions that shape them.

    Served from here rather than duplicated in the backend so the wording and
    the prompt it drives can never drift apart.
    """
    return BUILT_IN


@router.post("/summarize", response_model=SummaryResponse)
async def summarize(
    body: SummarizeRequest,
    pipeline: Pipeline = Depends(get_pipeline),
) -> SummaryResponse:
    # A slug names a built-in and wins over an inline template: it is what
    # Spring sends, and resolving it here is what keeps the section wording
    # from having to be stored anywhere else.
    template = resolve(body.template_slug) if body.template_slug else body.template
    summary = await pipeline.summarize(
        body.transcript,
        duration_seconds=body.duration_seconds,
        speaker_count=body.speaker_count,
        template=template,
    )
    # Derived here rather than left to the caller: Spring persists these, and
    # the key-to-kind mapping must not be duplicated in a second language where
    # it would drift from the templates it reads.
    summary.insights = derive_insights(summary.sections)
    return summary


@router.post("/extract-action-items", response_model=ActionItemsResponse)
async def extract_action_items(
    body: TranscriptInput,
    pipeline: Pipeline = Depends(get_pipeline),
) -> ActionItemsResponse:
    items = await pipeline.extract_action_items(body.transcript)
    return ActionItemsResponse(action_items=items)


@router.post("/process-meeting", response_model=MeetingBriefResult)
async def process_meeting(
    body: ProcessMeetingRequest,
    pipeline: Pipeline = Depends(get_pipeline),
    settings: Settings = Depends(get_settings),
) -> MeetingBriefResult:
    if not body.audio_url and not body.audio_path and settings.ai_provider != "mock":
        raise HTTPException(status_code=400, detail="audioUrl or audioPath is required")
    audio, filename = await fetch_audio(
        settings, audio_url=body.audio_url, object_key=body.audio_path
    )
    # No progress_hook here: HTTP callers get the result synchronously.
    return await pipeline.process(body.meeting_id, audio, filename)


@router.post("/index", response_model=IndexResponse)
async def index(body: IndexRequest, rag: RagService = Depends(get_rag)) -> IndexResponse:
    """Re-index a meeting's transcript, replacing whatever was stored before.

    Called by Spring after a user edits the transcript. Without it, "ask this
    meeting" keeps answering from the text the user just corrected — retrieval
    reads the chunks, not the segments, so an edit that is not re-indexed is
    invisible to chat and to search.
    """
    await rag.index(body.meeting_id, body.user_id, body.transcript, body.segments)
    return IndexResponse(indexed=True)


@router.post("/chat", response_model=ChatResponse)
async def chat(body: ChatRequest, rag: RagService = Depends(get_rag)) -> ChatResponse:
    """Answer a question grounded in one meeting's transcript (RAG over pgvector)."""
    answer, citations = await rag.answer(body.meeting_id, body.question, body.user_id)
    return ChatResponse(answer=answer, citations=[Citation(**c) for c in citations])


@router.post("/workspace-chat", response_model=ChatResponse)
async def workspace_chat(
    body: WorkspaceChatRequest, rag: RagService = Depends(get_rag)
) -> ChatResponse:
    """Answer a question grounded across every meeting the user owns.

    Retrieval filters on `user_id`, so cross-tenant grounding is impossible even
    if a caller passes someone else's meeting ids.
    """
    answer, citations = await rag.answer_workspace(
        body.user_id, body.question, body.meeting_ids
    )
    return ChatResponse(answer=answer, citations=[Citation(**c) for c in citations])


@router.post("/semantic-search", response_model=SemanticSearchResponse)
async def semantic_search(
    body: SemanticSearchRequest, rag: RagService = Depends(get_rag)
) -> SemanticSearchResponse:
    """Meaning-based search over the user's transcripts (best passage per meeting)."""
    hits = await rag.search(body.user_id, body.query, body.limit)
    return SemanticSearchResponse(hits=[SemanticSearchHit(**h) for h in hits])


@router.post("/draft-email", response_model=DraftEmailResponse)
async def draft_email(
    body: DraftEmailRequest, pipeline: Pipeline = Depends(get_pipeline)
) -> DraftEmailResponse:
    """Draft the follow-up email for a meeting, grounded in its brief."""
    return await pipeline.draft_followup_email(body)


@router.post("/translate", response_model=TranslateResponse)
async def translate(
    body: TranslateRequest, pipeline: Pipeline = Depends(get_pipeline)
) -> TranslateResponse:
    translated = await pipeline.translate(body.text, body.target_language)
    return TranslateResponse(text=translated, target_language=body.target_language)
