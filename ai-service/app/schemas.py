"""Pydantic v2 schemas — the canonical JSON shapes from docs/api-contracts.md §5.

All models serialize to **camelCase** (matching the shared contract) while using
snake_case attribute names in Python. `populate_by_name=True` means both the
snake_case field name and the camelCase alias are accepted on input.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

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
    # 0-1 from the provider, or None where it does not say. Kept for
    # diagnostics rather than for display: a number beside every word is
    # clutter, but "which words was it least sure of" is the first question
    # worth asking about a transcript somebody says is wrong.
    confidence: float | None = None
    # Who said this word, canonically ("Speaker 2"). Modern diarization
    # attributes per word, not only per utterance, and dropping that was how a
    # one-word interjection came to be absorbed into the surrounding turn:
    # there was nowhere for "somebody else said this bit" to live. None on
    # transcripts recorded before this existed, and on providers that only
    # attribute whole utterances.
    speaker: str | None = None
    # The provider's own token ("A", "B") behind that label. Kept so a
    # diarization complaint can be traced to whoever caused it — see
    # `app.diarization.trace_lines`.
    speaker_raw: str | None = None


class Segment(CamelModel):
    start: float
    end: float
    speaker: str
    text: str
    # Empty when the provider gives no per-word timings; callers fall back to
    # estimating from the segment span, which is what every transcript recorded
    # before this field existed still does.
    words: list[Word] = Field(default_factory=list)
    # Set only when this utterance is in a *different* language from the
    # meeting's, and only when detection was confident. None therefore means
    # "same as the meeting, or not known" — never "detection failed", because
    # labelling every line would make the marker meaningless in the monolingual
    # meetings that are the overwhelming majority.
    language: str | None = None
    # How sure the provider was of the words, 0-1, or None where it did not
    # say. Not drawn in the ordinary transcript.
    confidence: float | None = None
    # Whether the speaker on this turn is the provider's attribution or a
    # stand-in for one it would not make. "unknown" is a real answer and is
    # rendered as such: a turn merged into Speaker 1 because nothing else was
    # known is a quotation attributed to somebody who may not have said it,
    # which is worse than an unattributed line.
    speaker_status: Literal["attributed", "unknown"] = "attributed"
    # Meeting-local identity, stable across renames: "spk_2". `speaker` is what
    # gets displayed and is therefore what a rename overwrites; this is what
    # picks the colour, so renaming Speaker 2 to Sarah does not also recolour
    # her. None for transcripts written before canonical numbering existed.
    speaker_key: str | None = None
    # The provider's cluster id ("A", "D") this turn came from. Not shown. Its
    # value is that a renumbering bug is otherwise undiagnosable after the
    # fact — the display label alone cannot tell you whether the provider
    # merged two people or Recallix mislabelled one.
    speaker_raw: str | None = None


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
    # Where this topic starts, in seconds, so the heading can be clicked to jump
    # to it. None whenever it could not be established — the transcript given to
    # the model carries no timestamps, so this is resolved afterwards by finding
    # `start_quote` in the segments (see app.quotes.anchor_outline). A heading
    # without one renders as plain text rather than as a link to a guess.
    start_seconds: float | None = None
    # The model's claim about which words open the topic. Scaffolding: it is
    # matched against the transcript and then cleared, so it never leaves the
    # service.
    start_quote: str = ""


class SummarySection(CamelModel):
    """A section as written. Only the field matching `kind` is populated."""

    key: str
    title: str
    kind: Literal["prose", "bullets", "outline"] = "prose"
    text: str = ""
    bullets: list[str] = Field(default_factory=list)
    groups: list[OutlineGroup] = Field(default_factory=list)


class Quotation(CamelModel):
    """One line reproduced exactly as spoken, with where to hear it.

    Every quotation on this model has been matched back against the transcript
    by `app.quotes` — the model's candidates never reach a reader unchecked.
    `speaker` and `start` come from the segment it was found in rather than
    from the model, so the quote is clickable to the moment it was said.
    """

    text: str
    speaker: str = ""
    start: float = 0.0


class Insight(CamelModel):
    """One decision the meeting settled, or one risk it named.

    Derived from the summary sections rather than extracted separately, so the
    store and the notes can never disagree — see `app.insights` for why that
    matters more than it sounds like it should.

    `source_section` records which section it was read from, which is what keeps
    "a risk" and "a blocker" distinguishable after they have been stored in the
    same place.
    """

    kind: Literal["DECISION", "RISK"]
    text: str
    source_section: str = ""


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
    # Verified against the transcript before they get here; anything the model
    # could not have copied from it has already been dropped.
    quotes: list[Quotation] = Field(default_factory=list)
    # Read out of `sections` above, not extracted separately: the decision store
    # and the Decisions section are the same words, so they cannot drift apart.
    insights: list[Insight] = Field(default_factory=list)
    # Starter questions for this meeting's chat. Generated once here rather than
    # on every page load: they are derived from a summary that does not change,
    # so regenerating per view would be a model call per visit for an identical
    # answer.
    suggestions: list[str] = Field(default_factory=list)
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
    # A name for the meeting, read off the same transcript as the notes.
    #
    # Only useful to a recording, which arrives called "Recording — 20/08/2026,
    # 05:03": a date is not a name, and a list of them cannot be scanned. An
    # uploaded file already has a name its owner chose, and Spring will not
    # overwrite one -- see `auto_title` there.
    #
    # None or empty is a real answer and the expected one for a recording with
    # nothing in it. A title invented over silence would be worse than the
    # timestamp, because it would look like a meeting happened.
    title: str | None = None
    short_summary: str
    detailed_summary: str
    key_points: list[str] = Field(default_factory=list)
    # The template's sections as written. The three fields above are still
    # populated from them, because export, the share page and the recap email
    # all read those and must not care which template ran.
    sections: list[SummarySection] = Field(default_factory=list)
    template_slug: str | None = None
    # Starter questions for this meeting's chat, generated from the sections
    # above. Empty when the model could not produce specific ones, which is a
    # valid answer — the UI falls back to its written-by-hand prompts, and three
    # generic chips are worse than three good static ones.
    suggestions: list[str] = Field(default_factory=list)
    # Read out of `sections` above. Carried on this response, and not only on
    # the pipeline's, because re-summarizing under a different template goes
    # through here — and a template switch that changed the notes but left the
    # old decisions behind would produce exactly the disagreement between the
    # store and the summary that deriving them was meant to make impossible.
    insights: list[Insight] = Field(default_factory=list)


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
    # How hard to look: "express" or "advanced", same two words the workspace
    # chat uses. Defaults to express, which is exactly the behaviour every
    # caller got before the field existed, so an older Spring keeps working.
    mode: str = "express"
    # The user's own earlier questions in this thread, oldest first. Without
    # them "which of those changed later?" has no referent and is answered as
    # though "those" were a word in the transcript. Their questions only —
    # never previous answers, which would let one loose claim become the
    # evidence for the next.
    history: list[str] = Field(default_factory=list)


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


class SuggestionsResponse(CamelModel):
    """Starter questions for a chat.

    Always a valid response, including when empty: the caller has static
    prompts to fall back on, and offering nothing is better than offering three
    questions this material cannot answer.
    """

    suggestions: list[str] = Field(default_factory=list)


class WorkspaceSuggestionsRequest(CamelModel):
    """Starter questions across everything one user owns.

    `meeting_ids` narrows them to what the reader selected through Add context.
    Absent means the whole workspace, which is what every caller sent before
    this field existed.
    """

    user_id: str
    meeting_ids: list[str] | None = None


class WorkspaceChatRequest(CamelModel):
    """Ask a question across every meeting a user owns."""

    user_id: str
    question: str
    # Optional narrowing: search only these meetings instead of all of them.
    meeting_ids: list[str] | None = None
    # How hard to look. "express" is the default and is what every caller got
    # before this existed, so an old client keeps its exact behaviour; the two
    # differ in retrieval width and in whether the answer is asked to enumerate.
    # See RagService.answer_workspace.
    mode: Literal["express", "advanced"] = "express"
    # How far back to read, in days. None means every meeting the user owns,
    # which is what every caller got before the setting existed. A scope
    # control rather than a privacy boundary: nothing is hidden or deleted, and
    # the meeting's own chat still answers about it.
    history_days: int | None = None
    # The user's own earlier questions in this thread, oldest first, for
    # resolving what "those" and "it" point at. Not to be confused with
    # `history_days` above, which is about the archive rather than the thread.
    history: list[str] = Field(default_factory=list)


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


class TranslateLinesRequest(CamelModel):
    """Many short texts whose positions carry meaning.

    Used for key points, summary bullets, action items and transcript
    utterances — lists where line 4 belongs to whoever line 4 belonged to
    before. The response is guaranteed to be the same length in the same order;
    anything that could not be translated comes back as its source text.
    """

    lines: list[str]
    target_language: str


class TranslateLinesResponse(CamelModel):
    lines: list[str]
    target_language: str


# --------------------------------------------------------------------------- #
# Kafka event shapes (§6)
# --------------------------------------------------------------------------- #
class StatusEvent(CamelModel):
    meeting_id: str
    status: MeetingStatus
    progress: int = 0
    message: str = ""


class StreamingTokenResponse(CamelModel):
    """A short-lived AssemblyAI streaming credential, on its way to a browser.

    The token is the only secret in this response and it is meant to leave the
    building -- that is what it is for. `expires_in_seconds` is here so the
    client can decide whether the one it holds is still worth trying, rather
    than finding out from a refused websocket.
    """

    token: str
    expires_in_seconds: int


class SpeakerExpectation(CamelModel):
    """How many people to expect, when somebody actually knows.

    <p><b>These are hard constraints at the provider.</b> An exact count forces
    diarization to find that many voices whether or not that many spoke, so it
    is only ever sent when a human chose it. A calendar with four attendees is
    not four speakers — two of them were listening — and inferring the count
    from an invitation is how a two-person conversation comes back split into
    four.

    <p>"auto" is therefore the default and stays the default unless somebody
    says otherwise. A range is the middle setting for the common case: you know
    roughly how many were in the room, not exactly who spoke.
    """

    mode: Literal["auto", "exact", "range"] = "auto"
    exact: int | None = None
    minimum: int | None = None
    maximum: int | None = None

    def normalised(self) -> "SpeakerExpectation":
        """The same intent with impossible combinations removed.

        Sanitised here rather than at the adapter so that every provider gets
        the same answer, and so an out-of-range number becomes "auto" — the
        behaviour somebody had before the setting existed — rather than a
        rejected job.
        """
        if self.mode == "exact":
            if self.exact is None or not 1 <= self.exact <= 10:
                return SpeakerExpectation()
            return SpeakerExpectation(mode="exact", exact=self.exact)
        if self.mode == "range":
            low, high = self.minimum, self.maximum
            if low is None and high is None:
                return SpeakerExpectation()
            if low is not None and not 1 <= low <= 10:
                low = None
            if high is not None and not 1 <= high <= 10:
                high = None
            if low is not None and high is not None and low > high:
                low, high = high, low
            if low is None and high is None:
                return SpeakerExpectation()
            return SpeakerExpectation(mode="range", minimum=low, maximum=high)
        return SpeakerExpectation()


class MeetingContext(CamelModel):
    """What Recallix knows about a recording before transcribing it.

    Carried on the event rather than looked up by the worker: the worker has
    no user context, and pinning the values at enqueue keeps a rename mid-run
    from changing a transcript halfway through.

    There was a ``participants`` list here, filled from the account's known
    speakers and used for prompting and keyterms. Known speakers were removed
    from the product, so nothing fills it and it is gone rather than sent empty
    forever.
    """

    title: str | None = None
    project: str | None = None
    #: The summary template's human name, not its slug.
    meeting_type: str | None = None
    organisations: list[str] = []


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
    # ISO-639-1 code the user says their meetings are held in, resolved by
    # Spring at enqueue: the worker has no user context to read it in. None or
    # empty means detect, which is what every job did before the setting
    # existed.
    #
    # A `vocabulary` list sat beside this and carried the account's custom
    # terms as boosting hints. That feature is gone. Events still in the topic
    # may carry the field; Pydantic ignores what the model does not declare, so
    # a backlog published before this change still processes.
    language: str | None = None
    # What the recording is about, for transcription prompting. Absent on
    # events published before this field existed, which read as "nothing
    # known" and produce no prompt at all.
    context: MeetingContext | None = None
    # How many voices to expect. Absent means auto, which is what every job
    # did before the setting existed.
    speakers: SpeakerExpectation | None = None
    # Treat each audio channel as its own speaker. Only ever true when the
    # source is known to be channel-separated -- a stereo recording of a room
    # has everybody on both channels, and splitting it by channel would invent
    # two speakers out of one.
    multichannel: bool = False


class ProcessingFailedEvent(CamelModel):
    meeting_id: str
    error: str


# --------------------------------------------------------------------------- #
# Speaker identification
# --------------------------------------------------------------------------- #
class SpeakerTurnsDto(CamelModel):
    """One canonical speaker in one meeting, as Spring knows them.

    `speakerKey` is the meeting-local identity ("spk_2") rather than the display
    name, because the display name is the thing about to change. `displayName`
    is sent anyway, and it does real work: it is how this service tells an
    unresolved "Speaker 2" from a Sarah somebody typed, and it supplies the set
    of names already taken in this meeting.

    `spans` are the start/end pairs of that speaker's turns. Sent rather than
    re-derived here because the segments are Spring's, and they may have been
    edited since the transcript was written.
    """

    speaker_key: str
    display_name: str = ""
    spans: list[tuple[float, float]] = Field(default_factory=list)


class SpeakerIdentifyRequest(CamelModel):
    """Ask which unresolved speakers are confidently somebody already known.

    `objectKey` may be null: a recording erased by retention leaves a meeting
    whose voiceprints were computed while it still existed, and those keep
    working. Null with nothing cached simply means nothing can be identified.
    """

    user_id: str
    meeting_id: str
    object_key: str | None = None
    speakers: list[SpeakerTurnsDto] = Field(default_factory=list)


class SpeakerMatchDto(CamelModel):
    """A proposal. Spring applies it; this service never edits a transcript."""

    speaker_key: str
    display_name: str
    profile_id: str
    # Cosine, for logs and tests. Deliberately never rendered as a percentage —
    # it is not a calibrated probability. See app.voiceprints.
    similarity: float


class SpeakerIdentifyResponse(CamelModel):
    matches: list[SpeakerMatchDto] = Field(default_factory=list)
    #: How many speakers were still wearing a generated label.
    considered: int = 0
    #: How many named voices this account has to compare against.
    profiles: int = 0
    #: Set when the feature could not run at all, as distinct from running and
    #: matching nobody. The two deserve different sentences on screen.
    unavailable: str | None = None


class SpeakerLearnRequest(CamelModel):
    """Record that a voice belongs to the name a human just gave it."""

    user_id: str
    meeting_id: str
    object_key: str | None = None
    speaker_key: str
    display_name: str
    speakers: list[SpeakerTurnsDto] = Field(default_factory=list)


class SpeakerLearnResponse(CamelModel):
    #: Null when there was too little usable speech to build a template. An
    #: ordinary outcome: the rename itself already happened.
    profile_id: str | None = None
    learned: bool = False
    unavailable: str | None = None


class SpeakerForgetRequest(CamelModel):
    """Delete voice templates. Either one profile, or everything held."""

    user_id: str
    profile_id: str | None = None
    meeting_id: str | None = None


class SpeakerForgetResponse(CamelModel):
    deleted: int = 0
