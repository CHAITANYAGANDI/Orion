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


class Word(CamelModel):
    """One spoken word with its own timing, in seconds.

    Kept because a word's position inside an utterance cannot be inferred from
    the utterance's span: speech pauses, and a highlight that assumes an even
    rate runs ahead of the voice. Diarized utterances used to be short enough
    that the error stayed small, but a provider that groups a whole speaker
    turn can hand back thirty seconds in one segment, and over that distance
    the estimate is visibly wrong.
    """

    text: str
    start: float
    end: float


class Segment(CamelModel):
    start: float
    end: float
    speaker: str
    text: str
    # Empty when the provider gives no per-word timings; callers fall back to
    # estimating from the segment span, which is what every transcript recorded
    # before this field existed still does.
    words: list[Word] = Field(default_factory=list)


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
    action_items: list[ActionItem] = Field(default_factory=list)
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


class IndexRequest(CamelModel):
    """Re-index one meeting's transcript into pgvector.

    Sent after a transcript is edited. Indexing is delete-then-insert, so this
    is idempotent and replaces the meeting's chunks wholesale rather than
    appending — an edited passage must not stay retrievable in its old form.

    `user_id` is required for the same reason it is on the first index: it is
    what row-level security checks, and this service has no privilege to look
    an owner up.
    """

    meeting_id: str
    user_id: str
    transcript: str
    segments: list[Segment] = Field(default_factory=list)


class IndexResponse(CamelModel):
    indexed: bool


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
