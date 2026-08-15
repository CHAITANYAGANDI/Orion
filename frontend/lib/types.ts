// Types mirroring the Spring Boot DTOs from docs/api-contracts.md §5.
// IMPORTANT: API response field names follow the Spring DTOs. Notably the
// AI-side ActionItem uses `taskTitle`, but Spring's ActionItemResponse exposes
// `title` — we use `title` for everything the frontend consumes from Spring.

export type MeetingStatus =
  | "CREATED"
  | "UPLOADED"
  | "QUEUED"
  | "TRANSCRIBING"
  | "SUMMARIZING"
  | "EXTRACTING"
  | "READY"
  | "FAILED";

export type Priority = "high" | "medium" | "low";
export type Confidence = "high" | "medium" | "low";
export type Severity = "high" | "medium" | "low";
export type ActionItemStatus = "OPEN" | "IN_PROGRESS" | "DONE";
export type Plan = "FREE" | "PRO" | "PREMIUM";

// ---- Generic envelopes (api-contracts §3) ----
export interface Page<T> {
  content: T[];
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
}

export interface ApiError {
  timestamp: string;
  status: number;
  error: string;
  message: string;
  path: string;
  correlationId?: string;
}

// ---- Meetings ----
export interface UploadUrlRequest {
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface UploadUrlResponse {
  meetingId: string;
  uploadUrl: string;
  objectKey: string;
  expiresInSeconds: number;
}

/**
 * Confirming an upload. Deliberately almost empty: the meeting is named after
 * the uploaded file and everything else is edited afterwards, on the meeting
 * itself. `title` is only for callers whose filename is not a name — the
 * recorder, whose files are `recording-1755084000000.webm`.
 */
export interface MeetingCreateRequest {
  objectKey: string;
  title?: string;
  tags?: string[];
  contentType?: string;
  durationSeconds?: number;
}

/** Renaming or re-tagging afterwards. Omitted fields are left alone. */
export interface MeetingUpdateRequest {
  title?: string;
  tags?: string[];
}

/**
 * Where a meeting came from. AUDIO and YOUTUBE have a recording behind them;
 * DOCUMENT does not, so it renders without a player or transcript deep-links.
 */
export type SourceType = "AUDIO" | "YOUTUBE" | "DOCUMENT";

export interface MeetingResponse {
  id: string;
  title: string;
  status: MeetingStatus;
  tags: string[];
  audioUrl?: string | null;
  durationSeconds?: number | null;
  createdAt: string;
  errorMessage?: string | null;
  sourceType?: SourceType;
  sourceUrl?: string | null;
  /** Detected transcription language (ISO-639-1); absent until processed. */
  language?: string | null;
  /**
   * MIME type of the stored media. Drives the choice between a video and an
   * audio player. Absent for meetings created before it was persisted, and for
   * YouTube imports — both render as audio.
   */
  contentType?: string | null;
}

export interface PreferencesResponse {
  autoEmailRecap: boolean;
  recapEmail: string | null;
  /** Where recaps actually go — the override, or the account address. */
  effectiveRecapEmail: string | null;
}

export interface PreferencesUpdateRequest {
  autoEmailRecap?: boolean;
  recapEmail?: string;
}

export interface MeetingImportRequest {
  url: string;
  title?: string;
  tags?: string[];
}

/** One spoken word with its own timing, in seconds. */
export interface SpokenWord {
  text: string;
  start: number;
  end: number;
}

export interface TranscriptSegment {
  /** Addresses this segment when correcting its text. */
  id?: string;
  start: number;
  end: number;
  speaker: string;
  text: string;
  /**
   * Real per-word timings from the transcription provider. Empty for
   * transcripts recorded before these were persisted, where the highlight
   * falls back to estimating from the segment span.
   */
  words?: SpokenWord[];
  /**
   * ISO-639-1 code, present only when this line is in a different language from
   * the meeting's. Absent for monolingual meetings and for anything detection
   * could not call — so it marks exceptions rather than labelling every line.
   */
  language?: string | null;
}

/** How much of the talking one speaker did. Derived server-side on every read. */
export interface SpeakerStats {
  speaker: string;
  /** Seconds this speaker held the floor, summed across their turns. */
  speakingSeconds: number;
  /** Share of total *speaking* time, 0-100. Not share of wall-clock duration. */
  percentage: number;
  segmentCount: number;
  wordCount: number;
}

export interface TranscriptResponse {
  meetingId: string;
  transcript: string;
  language: string;
  segments: TranscriptSegment[];
  /** Ordered by who spoke most. Empty for a document, which has no speakers. */
  speakers: SpeakerStats[];
}

/**
 * Fix diarization rather than naming: merge a label that was split across two
 * speakers, or move individual turns to whoever actually said them. Exactly one
 * of `fromSpeaker` / `segmentIds` is sent.
 */
export interface SpeakerRematch {
  fromSpeaker?: string;
  toSpeaker: string;
  segmentIds?: string[];
}

export type VocabularyCategory = "KEYWORD" | "NAME" | "JARGON" | "ACRONYM";

/**
 * A transcription boosting hint. Sent with the transcription job, so it applies
 * to meetings processed after it is added — an existing transcript has to be
 * reprocessed to benefit from it.
 */
export interface VocabularyTerm {
  id: string;
  term: string;
  category: VocabularyCategory;
  /** What an acronym stands for. Empty for every other category. */
  expansion: string;
  active: boolean;
  createdAt: string;
}

export interface VocabularyTermInput {
  term: string;
  category: VocabularyCategory;
  expansion?: string;
  active?: boolean;
}

/** A name this user has applied to a speaker before, offered when renaming. */
export interface KnownSpeaker {
  id: string;
  displayName: string;
  timesUsed: number;
  lastUsedAt: string;
}

/** A heading with its bullets — the repeating unit of an `outline` section. */
export interface OutlineGroup {
  heading: string;
  bullets: string[];
}

/**
 * One section of a summary, as the template wrote it. Only the field matching
 * `kind` carries content, so the renderer switches on `kind` rather than
 * guessing from which arrays happen to be non-empty — an outline section with
 * no groups is a real, renderable state (the topic never came up).
 */
export interface SummarySection {
  key: string;
  title: string;
  kind: "prose" | "bullets" | "outline";
  text: string;
  bullets: string[];
  groups: OutlineGroup[];
}

/**
 * One line reproduced exactly as spoken, with where to hear it.
 *
 * Every quotation reaching the client has been matched back against the
 * transcript by the worker — the model's candidates never arrive unchecked —
 * and `speaker`/`start` come from the segment it was found in, so the quote is
 * clickable to the moment it was said.
 */
export interface Quotation {
  text: string;
  speaker: string;
  start: number;
}

export interface SummaryResponse {
  meetingId: string;
  shortSummary: string;
  detailedSummary: string;
  keyPoints: string[];
  /**
   * The template-shaped summary. Empty for meetings summarized before
   * templates existed — the three flat fields above still render those, and
   * are what the export and share page read regardless.
   */
  sections?: SummarySection[];
  /** Verified quotations. Empty for summaries generated before they existed. */
  quotes?: Quotation[];
  templateSlug?: string | null;
  /**
   * Starter questions for this meeting's chat, generated from this summary.
   * Empty when nothing specific could be generated — the UI falls back to its
   * hand-written prompts rather than showing generic ones.
   */
  suggestions?: string[];
  /**
   * The transcript has been edited since this summary was written, so the two
   * no longer agree. Not regenerated automatically — one model call per typo
   * fix is not a trade worth making — so the UI says so and offers the rewrite.
   */
  stale?: boolean;
}

/** One entry in the template picker. */
export interface SummaryTemplateResponse {
  slug: string;
  name: string;
  /** The headings this template produces — what actually explains the choice. */
  sectionTitles: string[];
}

// Spring ActionItemResponse — uses `title` (NOT the AI-side `taskTitle`).
export interface ActionItemResponse {
  id: string;
  meetingId: string;
  meetingTitle?: string | null;
  title: string;
  ownerName?: string | null;
  dueDate?: string | null;
  priority: Priority;
  status: ActionItemStatus;
  sourceSentence?: string | null;
  createdAt?: string;
}

export interface ActionItemPatchRequest {
  ownerName?: string | null;
  dueDate?: string | null;
  priority?: Priority;
  status?: ActionItemStatus;
}

export interface ReprocessResponse {
  meetingId: string;
  status: MeetingStatus;
}

// ---- RAG chat ----
export interface Citation {
  chunkIndex: number;
  start?: number | null;
  end?: number | null;
  text: string;
  // Present on workspace-wide answers, which span meetings; null for
  // single-meeting chat where the meeting is implied.
  meetingId?: string | null;
  meetingTitle?: string | null;
}

export interface ChatMessage {
  id: string;
  /** The thread this turn belongs to. */
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  createdAt: string;
}

export interface ChatAskRequest {
  question: string;
  /** Omit to continue the thread last used, or start one. */
  conversationId?: string;
}

/**
 * One named chat thread.
 *
 * `meetingId` is null for the workspace-wide chat. `updatedAt` — not
 * `createdAt` — is what the history picker sorts and groups by: a thread
 * returned to this morning belongs under "Today" however old it is.
 */
export interface ChatConversation {
  id: string;
  meetingId: string | null;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

// ---- Workspace-wide chat & semantic search ----
export interface WorkspaceAskRequest {
  question: string;
  meetingIds?: string[];
  /** Omit to continue the thread last used, or start one. */
  conversationId?: string;
}

export interface SemanticSearchRequest {
  query: string;
  limit?: number;
}

export interface SemanticSearchHit {
  meetingId: string;
  meetingTitle: string;
  meetingStatus: MeetingStatus;
  meetingCreatedAt: string;
  chunkIndex: number;
  snippet: string;
  start?: number | null;
  end?: number | null;
  score: number; // cosine similarity in [0,1]
}

// ---- Translation ----
export interface TranslateResult {
  targetLanguage: string;
  shortSummary: string;
  detailedSummary: string;
  keyPoints: string[];
}

/** One corrected line. Text only — timings come from the recording. */
export interface SegmentEdit {
  id: string;
  text: string;
}

// ---- Speaker rename ----
export interface SpeakerRenameRequest {
  mapping: Record<string, string>;
}

// ---- Sharing & follow-up ----
export interface ShareCreateRequest {
  includeTranscript?: boolean;
  expiresInDays?: number;
}

export interface ShareResponse {
  token: string;
  url: string;
  includeTranscript: boolean;
  expiresAt?: string | null;
  viewCount: number;
  lastViewedAt?: string | null;
  createdAt: string;
}

/**
 * A decision the meeting settled, or a risk it named.
 *
 * Read out of the summary sections rather than extracted separately, so these
 * and the Decisions section on the same page are the same words. `sourceSection`
 * is what keeps a blocker distinguishable from a risk once both are stored as
 * `RISK` — one is already happening, the other might.
 */
export interface Insight {
  id: string;
  meetingId: string;
  kind: "DECISION" | "RISK";
  text: string;
  sourceSection: string;
  /** True once a person has edited or added it, rather than the model. */
  edited: boolean;
  createdAt: string;
}

// ---- Transcript moments ----

export type MomentKind = "HIGHLIGHT" | "BOOKMARK" | "NOTE";

/**
 * One transcript segment's share of a marked passage.
 *
 * A selection that crosses an utterance boundary produces several of these,
 * which is common: diarization splits on pauses rather than on sentences, so
 * one spoken sentence often arrives as two segments.
 *
 * Two anchors, deliberately. The offsets are exact while the line is untouched;
 * `quote` is what finds the passage again after somebody fixes a typo earlier
 * in the same line and shifts every offset after it. See `resolveRange` in
 * `lib/moments.ts` for the order they are tried in.
 */
export interface MomentRange {
  segmentId: string;
  startOffset: number;
  endOffset: number;
  quote: string;
}

/** Something a person marked on a transcript: a highlight, a bookmark or a note. */
export interface TranscriptMoment {
  id: string;
  meetingId: string;
  kind: MomentKind;
  /** Empty for a bookmark, which marks a time rather than a passage. */
  ranges: MomentRange[];
  /** The selected words, joined. */
  quote: string;
  /** The user's own words: a note's text, or a bookmark's label. */
  body: string;
  /** Denormalised — the segment it came from may not survive a reprocess. */
  speaker: string;
  startSeconds: number;
  endSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface MomentCreateRequest {
  kind: MomentKind;
  ranges: MomentRange[];
  quote: string;
  body: string;
  speaker: string;
  startSeconds: number;
  endSeconds: number;
}

/** Recording a commitment the extraction pass missed. */
export interface ActionItemCreateRequest {
  title: string;
  ownerName?: string;
  dueDate?: string;
  priority?: Priority;
  /** The transcript line it came from — the same field the extractor fills. */
  sourceSentence?: string;
}

/** The anonymous view of a shared meeting — no ids, no audio, no owner. */
export interface SharedMeeting {
  title: string;
  meetingDate: string;
  durationSeconds?: number | null;
  shortSummary?: string | null;
  detailedSummary?: string | null;
  keyPoints: string[];
  actionItems: {
    title: string;
    ownerName?: string | null;
    dueDate?: string | null;
    priority: Priority;
  }[];
  transcript?: string | null;
}

export interface EmailDraft {
  subject: string;
  body: string;
}

// ---- Billing & usage ----
export interface CheckoutRequest {
  plan: "PRO" | "PREMIUM";
}

export interface CheckoutResponse {
  checkoutUrl: string;
}

export interface UsageResponse {
  plan: Plan;
  periodStart: string;
  periodEnd: string;
  meetingsUsed: number;
  meetingsLimit: number; // -1 = unlimited
  aiMinutesUsed: number;
  aiMinutesLimit: number; // -1 = unlimited
}

// ---- WebSocket / status ----
export interface StatusEvent {
  meetingId: string;
  status: MeetingStatus;
  progress: number;
  message: string;
}

// ---- List query params ----
export interface MeetingListQuery {
  page?: number;
  size?: number;
  search?: string;
  tag?: string;
  status?: MeetingStatus;
}

export interface ActionItemListQuery {
  page?: number;
  size?: number;
  status?: ActionItemStatus;
  priority?: Priority;
}
