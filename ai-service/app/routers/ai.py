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
    SpeakerForgetRequest,
    SpeakerForgetResponse,
    SpeakerIdentifyRequest,
    SpeakerIdentifyResponse,
    SpeakerLearnRequest,
    SpeakerLearnResponse,
    SpeakerMatchDto,
    SpeakerTurnsDto,
    SuggestionsResponse,
    SummarizeRequest,
    SummaryResponse,
    SummaryTemplate,
    TranscribeRequest,
    TranscriptInput,
    TranscriptResponse,
    TranslateLinesRequest,
    TranslateLinesResponse,
    TranslateRequest,
    TranslateResponse,
    StreamingTokenResponse,
    WorkspaceChatRequest,
    WorkspaceSuggestionsRequest,
)
from app.speaker_identity import (
    SpeakerIdentityService,
    SpeakerIdentityUnavailable,
    SpeakerTurns,
)
from app.storage import fetch_audio
from app.streaming import StreamingTokenError, StreamingTokenService
from app.suggestions import blend, meeting_material, signal_questions
from app.templates import BUILT_IN, resolve

logger = logging.getLogger("ai-service.router.ai")

router = APIRouter(prefix="/ai", tags=["ai"])


def get_pipeline(request: Request) -> Pipeline:
    """Resolve the app-wide Pipeline built during startup."""
    return request.app.state.pipeline


def get_rag(request: Request) -> RagService:
    """Resolve the app-wide RagService built during startup."""
    return request.app.state.rag


def get_speakers(request: Request) -> SpeakerIdentityService:
    """Resolve the app-wide SpeakerIdentityService built during startup."""
    return request.app.state.speakers


def _turns(rows: list[SpeakerTurnsDto]) -> list[SpeakerTurns]:
    return [
        SpeakerTurns(
            speaker_key=r.speaker_key,
            display_name=r.display_name or "",
            spans=[(float(a), float(b)) for a, b in r.spans],
        )
        for r in rows
        if r.speaker_key
    ]


@router.post("/streaming-token", response_model=StreamingTokenResponse)
async def streaming_token(
    settings: Settings = Depends(get_settings),
) -> StreamingTokenResponse:
    """A credential the browser may hold for the length of one meeting start.

    Called by Spring, never by a browser: this service has no user session to
    authenticate and no rate limiter of its own, and both live one hop up. The
    thing being protected is `ASSEMBLYAI_API_KEY`, which never leaves this
    process -- what goes back is a token that can open one streaming session
    and expires in well under a minute.

    A 503 rather than an empty token when the key is missing. A caller handed a
    blank string opens a websocket that is refused, and the user is told "live
    text stopped" with nothing anywhere saying why.
    """
    service = StreamingTokenService(settings)
    try:
        token, ttl = await service.mint()
    except StreamingTokenError as exc:
        logger.warning("Streaming token unavailable: %s", exc)
        raise HTTPException(
            status_code=503, detail="Live transcription is not configured."
        ) from exc
    return StreamingTokenResponse(token=token, expires_in_seconds=ttl)


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
    # Regenerated alongside the notes, because a template switch changes what
    # the meeting page shows and the old chips would be asking about sections
    # that are no longer there. Failure is swallowed for the same reason as in
    # the pipeline: chips are not worth failing a rewrite over.
    try:
        material = meeting_material(summary.short_summary, summary.sections)
        if material.strip():
            summary.suggestions = await pipeline.suggest_questions(material)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not suggest questions while summarizing: %s", exc)
    return summary


@router.post("/suggestions/workspace", response_model=SuggestionsResponse)
async def workspace_suggestions(
    body: WorkspaceSuggestionsRequest,
    pipeline: Pipeline = Depends(get_pipeline),
    rag: RagService = Depends(get_rag),
) -> SuggestionsResponse:
    """Starter questions across one user's archive.

    Unlike a meeting's chips, these have no natural moment to be generated at —
    a workspace has no "processed" event — so they are generated on request and
    cached by the caller. Spring owns that cache: it knows when a meeting last
    landed, which is what should expire them.

    An empty archive returns an empty list rather than an error, and the UI
    falls back to its static prompts.
    """
    selection = bool(body.meeting_ids)
    material = await rag.workspace_material(body.user_id, body.meeting_ids)

    # A selection is answered entirely from what was selected: signals are
    # facts about the whole workspace, and mixing "what overdue commitments
    # need attention?" into chips for three meetings somebody just chose is the
    # picker appearing not to have worked.
    if selection:
        if not material.strip():
            return SuggestionsResponse(suggestions=[])
        return SuggestionsResponse(
            suggestions=await pipeline.suggest_questions(
                material, workspace=True, scope="selection"
            )
        )

    signals = await rag.workspace_signals(body.user_id)
    generated: list[str] = []
    if material.strip():
        generated = await pipeline.suggest_questions(
            material, workspace=True, scope="workspace"
        )
    # An archive with nothing in it gets nothing, and the UI falls back to its
    # written-by-hand prompts. Blending the static floor in here instead would
    # offer "What still needs to be completed?" to somebody with no meetings.
    if not material.strip() and not signals.get("open_items") and not signals.get("decisions"):
        return SuggestionsResponse(suggestions=[])

    return SuggestionsResponse(
        suggestions=blend(
            signal_questions(
                overdue=signals.get("overdue", 0),
                open_items=signals.get("open_items", 0),
                decisions=signals.get("decisions", 0),
                recurring=signals.get("recurring"),
            ),
            generated,
        )
    )


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


@router.post("/speakers/identify", response_model=SpeakerIdentifyResponse)
async def identify_speakers(
    body: SpeakerIdentifyRequest,
    speakers: SpeakerIdentityService = Depends(get_speakers),
) -> SpeakerIdentifyResponse:
    """Which unresolved speakers in this meeting are confidently somebody known.

    Returns proposals only. Applying them is Spring's job, because Spring owns
    the transcript and everything downstream of it — the flat text, the
    retrieval index, the exports. Splitting it the other way would give this
    service write access to a transcript it cannot re-derive.

    Unavailability is reported in the body rather than as a 5xx. "We could not
    look" and "we looked and nobody matched" are different sentences on screen,
    and an exception here would collapse them into the same red toast.
    """
    try:
        outcome = await speakers.identify(
            body.user_id, body.meeting_id, _turns(body.speakers),
            object_key=body.object_key,
        )
    except SpeakerIdentityUnavailable as exc:
        return SpeakerIdentifyResponse(unavailable=str(exc))

    return SpeakerIdentifyResponse(
        matches=[
            SpeakerMatchDto(
                speaker_key=m.speaker_key,
                display_name=m.display_name,
                profile_id=m.profile_id,
                similarity=round(m.similarity, 4),
            )
            for m in outcome.matches
        ],
        considered=outcome.considered,
        profiles=outcome.profiles_available,
    )


@router.post("/speakers/learn", response_model=SpeakerLearnResponse)
async def learn_speaker(
    body: SpeakerLearnRequest,
    speakers: SpeakerIdentityService = Depends(get_speakers),
) -> SpeakerLearnResponse:
    """Remember that this voice is called this, because a human said so.

    Called by Spring after a manual rename, and only for accounts that have
    switched speaker learning on. Failure is never fatal to the caller: the
    rename the user actually asked for has already been applied and committed.
    """
    try:
        profile_id = await speakers.learn(
            body.user_id,
            body.meeting_id,
            SpeakerTurns(body.speaker_key, body.display_name or "", []),
            object_key=body.object_key,
            all_speakers=_turns(body.speakers),
        )
    except SpeakerIdentityUnavailable as exc:
        return SpeakerLearnResponse(unavailable=str(exc))
    return SpeakerLearnResponse(profile_id=profile_id, learned=profile_id is not None)


@router.post("/speakers/forget", response_model=SpeakerForgetResponse)
async def forget_speakers(
    body: SpeakerForgetRequest,
    speakers: SpeakerIdentityService = Depends(get_speakers),
) -> SpeakerForgetResponse:
    """Delete voice templates: one profile, one meeting's, or everything.

    Never reports a reason it could not run. Deletion has to be as close to
    unconditional as the code can make it — a request to remove biometric data
    that fails softly because a model is missing would be the worst possible
    place for this service to be fussy.
    """
    if body.profile_id:
        gone = await speakers.forget_profile(body.user_id, body.profile_id)
        return SpeakerForgetResponse(deleted=1 if gone else 0)
    if body.meeting_id:
        return SpeakerForgetResponse(
            deleted=await speakers.forget_meeting_voiceprints(body.user_id, body.meeting_id)
        )
    return SpeakerForgetResponse(deleted=await speakers.forget_everything(body.user_id))


@router.post("/chat", response_model=ChatResponse)
async def chat(body: ChatRequest, rag: RagService = Depends(get_rag)) -> ChatResponse:
    """Answer a question grounded in one meeting's transcript (RAG over pgvector)."""
    answer, citations = await rag.answer(
        body.meeting_id, body.question, body.user_id, body.mode, body.history
    )
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
        body.user_id, body.question, body.meeting_ids, body.mode,
        body.history_days, body.history,
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


@router.post("/translate-lines", response_model=TranslateLinesResponse)
async def translate_lines(
    body: TranslateLinesRequest, pipeline: Pipeline = Depends(get_pipeline)
) -> TranslateLinesResponse:
    """Translate a list without changing its shape.

    The length is the contract — see `LlmPort.translate_lines`. Enforced again
    here rather than trusted, because every caller indexes the result against
    the list it sent, and a short reply would silently attribute one speaker's
    words to another.
    """
    translated = await pipeline.translate_lines(body.lines, body.target_language)
    if len(translated) != len(body.lines):
        translated = list(body.lines)
    return TranslateLinesResponse(
        lines=translated, target_language=body.target_language
    )
