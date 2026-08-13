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

export interface MeetingCreateRequest {
  objectKey: string;
  title: string;
  participants: string[];
  tags: string[];
  contentType?: string;
  durationSeconds?: number;
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
  participants: string[];
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
}

export interface TranscriptResponse {
  meetingId: string;
  transcript: string;
  language: string;
  segments: TranscriptSegment[];
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
  templateSlug?: string | null;
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
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  createdAt: string;
}

export interface ChatAskRequest {
  question: string;
}

// ---- Workspace-wide chat & semantic search ----
export interface WorkspaceAskRequest {
  question: string;
  meetingIds?: string[];
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

/** The anonymous view of a shared meeting — no ids, no audio, no owner. */
export interface SharedMeeting {
  title: string;
  meetingDate: string;
  durationSeconds?: number | null;
  participants: string[];
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
