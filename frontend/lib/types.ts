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
}

export interface CalendarSubscriptionResponse {
  id: string;
  label: string | null;
  /** Host only — the real iCal URL is a secret and never leaves the server. */
  redactedUrl: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  eventCount: number;
}

export interface CalendarSubscribeRequest {
  url: string;
  label?: string;
}

export interface CalendarEventResponse {
  uid: string | null;
  title: string;
  start: string;
  end: string;
  location: string | null;
  /** Present when the event has an online meeting link. */
  meetingUrl: string | null;
  allDay: boolean;
  calendarLabel: string | null;
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

export interface TranscriptSegment {
  start: number;
  end: number;
  speaker: string;
  text: string;
}

export interface TranscriptResponse {
  meetingId: string;
  transcript: string;
  language: string;
  segments: TranscriptSegment[];
}

export interface SummaryResponse {
  meetingId: string;
  shortSummary: string;
  detailedSummary: string;
  keyPoints: string[];
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

export interface DecisionResponse {
  id?: string;
  meetingId?: string;
  decision: string;
  confidence: Confidence;
  sourceSentence?: string | null;
}

export interface RiskResponse {
  id?: string;
  meetingId?: string;
  risk: string;
  severity: Severity;
  sourceSentence?: string | null;
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

// ---- Speaker rename ----
export interface SpeakerRenameRequest {
  mapping: Record<string, string>;
}

// ---- Meeting Memory: commitment ledger + decision drift ----

/** Inferred from what later meetings said; the user can always override it. */
export type CommitmentStatus =
  | "OPEN"
  | "FULFILLED"
  | "SLIPPED"
  | "CANCELLED"
  | "DROPPED";

/** RESTATED = raised again with no resolution, so the commitment stays OPEN. */
export type EvidenceVerdict = "FULFILLED" | "SLIPPED" | "RESTATED" | "CANCELLED";

export type DriftRelation = "CONTRADICTS" | "SUPERSEDES" | "REAFFIRMS";

export interface CommitmentEvidence {
  id: string;
  meetingId: string;
  meetingTitle?: string | null;
  verdict: EvidenceVerdict;
  rationale?: string | null;
  quote?: string | null;
  start?: number | null;
  confidence?: string | null;
  createdAt: string;
}

export interface Commitment {
  id: string;
  text: string;
  ownerName?: string | null;
  dueDate?: string | null;
  status: CommitmentStatus;
  originMeetingId: string;
  originMeetingTitle?: string | null;
  actionItemId?: string | null;
  /** How many later meetings have been checked against this promise. */
  checksRun: number;
  lastCheckedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  evidence: CommitmentEvidence[];
}

export interface DecisionDrift {
  id: string;
  relation: DriftRelation;
  rationale?: string | null;
  similarity?: number | null;
  acknowledged: boolean;
  createdAt: string;
  earlierDecisionId: string;
  earlierText: string;
  earlierMeetingId: string;
  earlierMeetingTitle?: string | null;
  laterDecisionId: string;
  laterText: string;
  laterMeetingId: string;
  laterMeetingTitle?: string | null;
}

export interface MemoryStats {
  open: number;
  fulfilled: number;
  slipped: number;
  dropped: number;
  openContradictions: number;
}

export interface CommitmentListQuery {
  page?: number;
  size?: number;
  status?: CommitmentStatus;
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
  decisions: { decision: string; confidence: string; sourceSentence?: string | null }[];
  actionItems: {
    title: string;
    ownerName?: string | null;
    dueDate?: string | null;
    priority: Priority;
  }[];
  risks: { risk: string; severity: string; sourceSentence?: string | null }[];
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

// ---- Phase 2: Agent + Integrations (scaffold) ----
export type IntegrationProvider =
  | "notion"
  | "gmail"
  | "google_calendar"
  | "outlook_mail"
  | "outlook_calendar"
  | "microsoft_tasks";

export type IntegrationStatus = "CONNECTED" | "DISCONNECTED";

export interface IntegrationResponse {
  provider: IntegrationProvider;
  status: IntegrationStatus;
  connectedAt?: string | null;
}

export type AgentActionStatus =
  | "DRAFT"
  | "APPROVED"
  | "EXECUTED"
  | "FAILED"
  | "REJECTED";

export interface AgentAction {
  id: string;
  meetingId: string;
  type: string; // CREATE_NOTION_NOTE | DRAFT_EMAIL | CREATE_TASKS | CREATE_CALENDAR_EVENT ...
  provider: string;
  title?: string;
  subject?: string;
  body?: string;
  taskCount?: number;
  status: AgentActionStatus;
}

export interface AgentPlanResponse {
  meetingId: string;
  requiresApproval: boolean;
  actions: AgentAction[];
}
