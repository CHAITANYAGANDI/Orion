"""Pydantic v2 schemas — the canonical JSON shapes from docs/api-contracts.md §5.

All models serialize to **camelCase** (matching the shared contract) while using
snake_case attribute names in Python. `populate_by_name=True` means both the
snake_case field name and the camelCase alias are accepted on input.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

Priority = Literal["high", "medium", "low"]
Confidence = Literal["high", "medium", "low"]
Severity = Literal["high", "medium", "low"]

# Meeting lifecycle status (api-contracts.md §5 MeetingResponse).
MeetingStatus = Literal[
    "CREATED",
    "UPLOADED",
    "QUEUED",
    "TRANSCRIBING",
    "SUMMARIZING",
    "EXTRACTING",
    "READY",
    "FAILED",
]

# Where a meeting's content came from. AUDIO and YOUTUBE both transcribe;
# DOCUMENT is already text and skips transcription entirely.
SourceType = Literal["AUDIO", "YOUTUBE", "DOCUMENT"]


class CamelModel(BaseModel):
    """Base model: camelCase JSON aliases, populate by field name or alias."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="ignore",
    )


# --------------------------------------------------------------------------- #
# Canonical extraction shapes (§5)
# --------------------------------------------------------------------------- #
class ActionItem(CamelModel):
    task_title: str
    owner_name: str | None = None
    due_date: str | None = None
    priority: Priority = "medium"
    source_sentence: str


class Decision(CamelModel):
    decision: str
    confidence: Confidence = "medium"
    source_sentence: str


class Risk(CamelModel):
    risk: str
    severity: Severity = "medium"
    source_sentence: str


class Segment(CamelModel):
    start: float
    end: float
    speaker: str
    text: str


# --------------------------------------------------------------------------- #
# Summary templates
#
# Defined before MeetingBriefResult because the brief carries the sections a
# template produced.
# --------------------------------------------------------------------------- #
class TemplateSection(CamelModel):
    """One section a template asks the summary to contain.

    `kind` decides the shape the model must return and how the UI draws it:
    `prose` is a paragraph, `bullets` a flat list, `outline` headed groups of
    bullets — the walkthrough that makes a long meeting navigable.
    """

    key: str
    title: str
    kind: Literal["prose", "bullets", "outline"] = "prose"
    instruction: str


class SummaryTemplate(CamelModel):
    slug: str
    name: str
    sections: list[TemplateSection] = Field(default_factory=list)


class OutlineGroup(CamelModel):
    heading: str
    bullets: list[str] = Field(default_factory=list)


class SummarySection(CamelModel):
    """A section as written. Only the field matching `kind` is populated."""

    key: str
    title: str
    kind: Literal["prose", "bullets", "outline"] = "prose"
    text: str = ""
    bullets: list[str] = Field(default_factory=list)
    groups: list[OutlineGroup] = Field(default_factory=list)


class MeetingBriefResult(CamelModel):
    """Full result — FastAPI -> Spring callback + /ai/process-meeting response."""

    meeting_id: str
    transcript: str
    language: str = "en"
    segments: list[Segment] = Field(default_factory=list)
    short_summary: str
    detailed_summary: str
    key_points: list[str] = Field(default_factory=list)
    # The template's sections as written, for Spring to persist. The three
    # fields above stay populated from them so the export, share page and recap
    # email keep working without knowing which template ran.
    sections: list[SummarySection] = Field(default_factory=list)
    template_slug: str | None = None
    decisions: list[Decision] = Field(default_factory=list)
    action_items: list[ActionItem] = Field(default_factory=list)
    risks: list[Risk] = Field(default_factory=list)
    # Only populated for URL imports, where the worker discovers the real title
    # and length from the source. Spring uses them to replace its placeholder.
    title: str | None = None
    duration_seconds: int | None = None


# --------------------------------------------------------------------------- #
# HTTP request/response shapes (§4)
# --------------------------------------------------------------------------- #
class TranscribeRequest(CamelModel):
    audio_url: str | None = None
    audio_path: str | None = None


class TranscriptResponse(CamelModel):
    transcript: str
    language: str = "en"
    segments: list[Segment] = Field(default_factory=list)


class SummarizeRequest(CamelModel):
    transcript: str
    # Facts about the recording that the text cannot carry. Optional because a
    # caller summarizing loose text has neither, and the notes simply open
    # without them.
    duration_seconds: float | None = None
    speaker_count: int | None = None
    # Two ways to ask for a shape. `template_slug` names a built-in and is what
    # Spring sends, so the section instructions never have to be stored — or
    # kept in step — outside this service. `template` passes one inline, for a
    # caller experimenting with wording. Slug wins when both are given; absent
    # both, the General shape is used, so a caller that knows nothing about
    # templates keeps working.
    template_slug: str | None = None
    template: SummaryTemplate | None = None


class SummaryResponse(CamelModel):
    short_summary: str
    detailed_summary: str
    key_points: list[str] = Field(default_factory=list)
    # The template's sections as written. The three fields above are still
    # populated from them, because export, the share page and the recap email
    # all read those and must not care which template ran.
    sections: list[SummarySection] = Field(default_factory=list)
    template_slug: str | None = None


class TranscriptInput(CamelModel):
    transcript: str


class ActionItemsResponse(CamelModel):
    action_items: list[ActionItem] = Field(default_factory=list)


class DecisionsResponse(CamelModel):
    decisions: list[Decision] = Field(default_factory=list)


class RisksResponse(CamelModel):
    risks: list[Risk] = Field(default_factory=list)


class ProcessMeetingRequest(CamelModel):
    meeting_id: str
    audio_url: str | None = None
    audio_path: str | None = None


class HealthResponse(CamelModel):
    # `status` and `provider` are already single words -> unchanged by camelCase.
    status: str = "ok"
    provider: str


# --------------------------------------------------------------------------- #
# RAG chat + translation
# --------------------------------------------------------------------------- #
class ChatRequest(CamelModel):
    meeting_id: str
    question: str
    # The owner, used to satisfy row-level security on transcript_chunks.
    # Optional so the endpoint stays usable by hand, but Spring always sends it:
    # without it retrieval finds nothing, which is the intended fail-closed
    # behaviour rather than a fallback to reading everyone's transcripts.
    user_id: str | None = None


class Citation(CamelModel):
    chunk_index: int
    start: float | None = None
    end: float | None = None
    text: str
    # Populated for workspace-wide answers, which span meetings; left null for
    # single-meeting chat where the meeting is already implied by the request.
    meeting_id: str | None = None
    meeting_title: str | None = None


class ChatResponse(CamelModel):
    answer: str
    citations: list[Citation] = Field(default_factory=list)


class WorkspaceChatRequest(CamelModel):
    """Ask a question across every meeting a user owns."""

    user_id: str
    question: str
    # Optional narrowing: search only these meetings instead of all of them.
    meeting_ids: list[str] | None = None


class SemanticSearchRequest(CamelModel):
    user_id: str
    query: str
    limit: int | None = None


class SemanticSearchHit(CamelModel):
    meeting_id: str
    meeting_title: str
    chunk_index: int
    snippet: str
    start: float | None = None
    end: float | None = None
    meeting_created_at: str | None = None
    score: float = 0.0


class SemanticSearchResponse(CamelModel):
    hits: list[SemanticSearchHit] = Field(default_factory=list)


class DraftEmailRequest(CamelModel):
    """Everything the model needs to write a recap the user can actually send."""

    title: str
    short_summary: str = ""
    key_points: list[str] = Field(default_factory=list)
    decisions: list[str] = Field(default_factory=list)
    action_items: list[str] = Field(default_factory=list)
    # Optional steer: "keep it short", "address it to the client", etc.
    tone: str | None = None


class DraftEmailResponse(CamelModel):
    subject: str
    body: str


class TranslateRequest(CamelModel):
    text: str
    target_language: str


class TranslateResponse(CamelModel):
    text: str
    target_language: str


# --------------------------------------------------------------------------- #
# Meeting Memory — commitment ledger + decision drift
# --------------------------------------------------------------------------- #
# What a later meeting says about an earlier promise. NO_EVIDENCE is the common
# case and is never persisted as evidence.
CommitmentOutcome = Literal[
    "FULFILLED", "SLIPPED", "RESTATED", "CANCELLED", "NO_EVIDENCE"
]

# How two semantically-close decisions relate. UNRELATED means retrieval found
# shared vocabulary but the decisions do not actually interact.
DecisionRelationKind = Literal["CONTRADICTS", "SUPERSEDES", "REAFFIRMS", "UNRELATED"]


class CommitmentVerdict(CamelModel):
    """The LLM's reading of one commitment against one later meeting."""

    outcome: CommitmentOutcome = "NO_EVIDENCE"
    rationale: str = ""
    # Verbatim line that justifies the outcome; empty when NO_EVIDENCE.
    quote: str = ""
    confidence: Confidence = "medium"


class DecisionRelation(CamelModel):
    """The LLM's reading of a candidate decision pair."""

    relation: DecisionRelationKind = "UNRELATED"
    rationale: str = ""


class CommitmentInput(CamelModel):
    """An open commitment to reconcile against the meeting being processed."""

    id: str
    text: str
    owner_name: str | None = None
    due_date: str | None = None


class DecisionInput(CamelModel):
    """A decision recorded in the meeting being processed."""

    id: str
    text: str


class ReconcileRequest(CamelModel):
    user_id: str
    meeting_id: str
    open_commitments: list[CommitmentInput] = Field(default_factory=list)
    decisions: list[DecisionInput] = Field(default_factory=list)


class CommitmentVerdictResult(CamelModel):
    commitment_id: str
    outcome: CommitmentOutcome
    rationale: str = ""
    quote: str = ""
    # Where in the meeting the evidence was found, for deep-linking.
    start: float | None = None
    confidence: Confidence = "medium"


class DecisionLinkResult(CamelModel):
    earlier_decision_id: str
    later_decision_id: str
    relation: DecisionRelationKind
    rationale: str = ""
    similarity: float = 0.0


class ReconcileResponse(CamelModel):
    commitment_verdicts: list[CommitmentVerdictResult] = Field(default_factory=list)
    decision_links: list[DecisionLinkResult] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Kafka event shapes (§6)
# --------------------------------------------------------------------------- #
class StatusEvent(CamelModel):
    meeting_id: str
    status: MeetingStatus
    progress: int = 0
    message: str = ""


class MeetingUploadedEvent(CamelModel):
    meeting_id: str
    user_id: str | None = None
    audio_url: str | None = None
    object_key: str | None = None
    # Where the content comes from. AUDIO is the original path and stays the
    # default so events published before this field existed still validate.
    source_type: SourceType = "AUDIO"
    # Set for YOUTUBE; the object key carries the content for AUDIO/DOCUMENT.
    source_url: str | None = None
    # Which summary shape the user picked. None means General, so an event
    # published before this field existed still processes.
    summary_template: str | None = None


class ProcessingFailedEvent(CamelModel):
    meeting_id: str
    error: str


# --------------------------------------------------------------------------- #
# Phase 2 — agent scaffolding (docs/phase2-agent-mcp.md)
# --------------------------------------------------------------------------- #
class PlanActionsRequest(CamelModel):
    meeting_id: str
    brief: MeetingBriefResult | None = None
    instruction: str = "Create sensible follow-ups from this meeting."


class PlannedAction(CamelModel):
    type: str
    provider: str
    status: str = "DRAFT"
    title: str | None = None
    subject: str | None = None
    task_count: int | None = None


class ActionPlan(CamelModel):
    meeting_id: str
    requires_approval: bool = True
    actions: list[PlannedAction] = Field(default_factory=list)


class ValidateActionRequest(CamelModel):
    action: PlannedAction


class ValidateActionResponse(CamelModel):
    valid: bool
    reason: str
