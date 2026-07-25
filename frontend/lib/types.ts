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
