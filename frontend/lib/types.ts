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
  summaryTemplate?: string;
  /**
   * File it as it arrives. The one piece of metadata worth asking for up front:
   * whoever is uploading knows which project this belongs to before they have
   * heard a word of it.
   */
  projectId?: string;
  /**
   * The recorder confirming they told the room (V35).
   *
   * Only the browser recorder sends this — it is the only client that was
   * present when the recording started. Recorded, not verified.
   */
  consentConfirmed?: boolean;
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
  /** The project it is filed under, or null for unfiled (V30). */
  projectId?: string | null;
  /**
   * When the recording was erased, or null (V35).
   *
   * Distinct from having no `audioUrl`, which is also true of a YouTube import
   * and of an upload still in flight. Three different situations that would
   * otherwise share one unhelpful sentence.
   */
  audioDeletedAt?: string | null;
  /** When the transcript was erased. The summary and tasks outlive it. */
  transcriptDeletedAt?: string | null;
  /** When the person recording confirmed they had told the room. */
  consentConfirmedAt?: string | null;
}

export interface PreferencesResponse {
  /**
   * The address the sign-in provider gave us, or null.
   *
   * Read-only: it is the provider's fact, and a development session has no
   * provider and therefore no address at all. `recapEmail` is the editable one.
   */
  email: string | null;
  autoEmailRecap: boolean;
  recapEmail: string | null;
  /** Where recaps actually go — the override, or the account address. */
  effectiveRecapEmail: string | null;
  /**
   * What this user is called in their own meetings. The only thing that can
   * turn a list of owners into "my tasks"; null until they say.
   */
  displayName: string | null;
  /** Descriptive only — nothing routes by either (V38). */
  department: string | null;
  jobRole: string | null;
  /** ISO-639-1 spoken language for transcription; null means auto-detect. */
  defaultLanguage: string | null;
  /** Daily digest of what is overdue or due soon. */
  taskReminders: boolean;
  /** Notification kinds switched off. Everything absent from this is on. */
  mutedNotifications: string[];
}

export interface PreferencesUpdateRequest {
  autoEmailRecap?: boolean;
  recapEmail?: string;
  /** Blank clears it. */
  displayName?: string;
  department?: string;
  jobRole?: string;
  /** ISO-639-1 code; blank restores auto-detect. */
  defaultLanguage?: string;
  taskReminders?: boolean;
  /** The whole set, not a delta — the settings page holds every switch at once. */
  mutedNotifications?: string[];
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

/**
 * How a task stands against its deadline, decided by the server.
 *
 * The list, the badge and the reminder email have to agree on what "overdue"
 * means, and one of those runs on a scheduler rather than in this browser — so
 * the rule lives in Java and this is the answer, not a second implementation.
 */
export type DueStatus = "NONE" | "OVERDUE" | "TODAY" | "SOON" | "LATER";

// Spring ActionItemResponse — uses `title` (NOT the AI-side `taskTitle`).
export interface ActionItemResponse {
  id: string;
  /**
   * The conversation it was promised in, or null for one typed by hand (V36).
   *
   * Nullable since the workspace panel learned to create tasks that were never
   * said out loud. Every place that renders a link back to the meeting has to
   * cope with there not being one.
   */
  meetingId?: string | null;
  meetingTitle?: string | null;
  title: string;
  ownerName?: string | null;
  /** The deadline in the words it was said in — "Tuesday", "end of day". */
  dueDate?: string | null;
  /** That deadline as a date, absent when the phrasing had no single reading. */
  dueOn?: string | null;
  dueStatus: DueStatus;
  /** Negative when overdue, 0 today, null when there is no resolved date. */
  daysUntilDue?: number | null;
  priority: Priority;
  status: ActionItemStatus;
  sourceSentence?: string | null;
  /** Where the source sentence sits in the recording, when it could be located. */
  sourceStartSeconds?: number | null;
  completedAt?: string | null;
  /** A person has changed this row, so a reprocess will leave it alone. */
  edited: boolean;
  commentCount: number;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * A null field means "leave it alone".
 *
 * `dueDate` is the exception: an empty string clears it, because null cannot
 * mean both "don't touch" and "remove".
 */
export interface ActionItemPatchRequest {
  title?: string;
  ownerName?: string | null;
  dueDate?: string | null;
  priority?: Priority;
  status?: ActionItemStatus;
}

export interface ActionItemOverview {
  counts: {
    open: number;
    overdue: number;
    dueSoon: number;
    mine: number;
    done: number;
  };
  /** The names actually assigned work here — what the owner filter offers. */
  owners: { name: string; count: number }[];
  /** What this user is called in their own meetings, or null if never said. */
  me?: string | null;
}

/** One entry in a task's private working log. No author — one account per workspace. */
export interface ActionItemComment {
  id: string;
  actionItemId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
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
  /** Set for a project chat. Both null is the workspace. */
  projectId: string | null;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

// ---- Projects (V30) ----

/**
 * A body of work meetings are filed into.
 *
 * Not a folder, and the difference is the feature: a project is a thing that is
 * happening, which is what makes "ask Recallix about this project" a sensible
 * sentence. Exactly one per meeting, or none — tags remain the many-to-many.
 */
export interface Project {
  id: string;
  name: string;
  description: string;
  color: string;
  /** Starred: listed first in the rail and on the folder page (V37). */
  favorite: boolean;
  /** What makes the row worth showing, and whether asking it anything can work. */
  meetingCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInput {
  name?: string;
  description?: string;
  color?: string;
  /** Omitted leaves the star alone — sending `false` is how it is removed. */
  favorite?: boolean;
}

// ---- Workspace-wide chat & semantic search ----
export interface WorkspaceAskRequest {
  question: string;
  /** What "Add context" produces: the same question, narrowed to these calls. */
  meetingIds?: string[];
  /** Omit to continue the thread last used, or start one. */
  conversationId?: string;
  /** Omit for express, which is what the chat did before the picker existed. */
  mode?: ChatMode;
}

/** How hard the workspace chat looks before answering. */
export type ChatMode = "express" | "advanced";

/**
 * One row of the composer's mode picker, described by the server.
 *
 * The wording comes from the thing whose behaviour it changes, so "Balanced for
 * accuracy and speed" cannot drift away from what express actually does.
 */
export interface ChatModeOption {
  mode: ChatMode;
  label: string;
  hint: string;
  isDefault: boolean;
}

/**
 * The deadline calendar feed — the one integration Recallix actually has.
 *
 * `url` is the https form to paste into Google Calendar; `webcalUrl` is the
 * clickable form desktop calendars subscribe to. Both are null until a feed
 * exists, and both are secrets: the URL is the only credential a calendar
 * server can present.
 */
export interface CalendarFeed {
  enabled: boolean;
  url: string | null;
  webcalUrl: string | null;
  createdAt: string | null;
  /** How many dated, unfinished items the feed currently publishes. */
  deadlines: number;
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

// ---- Workspace search (GET /search) ----

/**
 * The five kinds of thing a search can find. `risks` is a sixth group and not
 * in the original sketch: decisions and risks are one store told apart by a
 * `kind` (V24), so searching one and not the other would leave a hole with no
 * explanation behind it — the term is in the archive, on the meeting page,
 * under a heading right beside Decisions, and search would not admit it.
 */
export type SearchGroupKey =
  | "meetings"
  | "people"
  | "decisions"
  | "risks"
  | "commitments"
  | "mentions";

/** A page of one kind of result, and how many there are in total. */
export interface SearchGroup<T> {
  total: number;
  hits: T[];
}

export interface SearchMeetingHit {
  id: string;
  title: string;
  status: MeetingStatus;
  createdAt: string;
  durationSeconds?: number | null;
  tags: string[];
  summaryTemplate: string;
  /** Matching utterances inside it — why a meeting with an unrelated title is here. */
  mentions: number;
  titleMatch: boolean;
}

/**
 * Someone in the archive. Not an account: Recallix has one of those per
 * workspace. Anyone who spoke, owns a commitment, or has been named as a
 * speaker before — `segments` counts what they said, `mentions` counts other
 * people saying their name, `commitments` counts what they owe. A person can
 * score high on the last two having attended nothing.
 */
export interface SearchPersonHit {
  name: string;
  meetings: number;
  segments: number;
  mentions: number;
  commitments: number;
}

export interface SearchInsightHit {
  id: string;
  meetingId: string;
  meetingTitle: string;
  meetingCreatedAt: string;
  kind: "DECISION" | "RISK";
  text: string;
}

/** A commitment — which in Recallix is an action item. There is no second store. */
export interface SearchCommitmentHit {
  id: string;
  meetingId: string;
  meetingTitle: string;
  meetingCreatedAt: string;
  title: string;
  owner?: string | null;
  status: ActionItemStatus;
  dueDate?: string | null;
  priority: Priority;
}

export interface SearchMentionHit {
  segmentId: string;
  meetingId: string;
  meetingTitle: string;
  meetingCreatedAt: string;
  speaker?: string | null;
  /** Seconds into the recording — what makes the mention worth listing. */
  start?: number | null;
  text: string;
}

export interface SearchResponse {
  query: string;
  meetings: SearchGroup<SearchMeetingHit>;
  people: SearchGroup<SearchPersonHit>;
  decisions: SearchGroup<SearchInsightHit>;
  risks: SearchGroup<SearchInsightHit>;
  commitments: SearchGroup<SearchCommitmentHit>;
  mentions: SearchGroup<SearchMentionHit>;
}

/**
 * The filters, all optional. Absent means "not filtering", which the API reads
 * as the empty string rather than null — see the Spring `SearchQuery`.
 *
 * There is no `participant` here and that is not an omission: V23 dropped the
 * participants table, so the only record of who was in a meeting is who spoke
 * in it. One concept, one filter.
 */
export interface SearchFilterState {
  from?: string;
  to?: string;
  status?: MeetingStatus | "";
  /** Summary-template slug — what a "meeting type" is in Recallix. */
  type?: string;
  tag?: string;
  /** A project id, or `none` for meetings filed nowhere (V30). */
  project?: string;
  speaker?: string;
  owner?: string;
  withDecisions?: boolean;
}

export interface SearchQueryArgs extends SearchFilterState {
  q: string;
  /** Absent asks for every group; naming one is how "see all" pages into it. */
  groups?: SearchGroupKey[];
  limit?: number;
  offset?: number;
}

/** What each filter can actually be set to in this workspace. */
export interface SearchFacets {
  speakers: string[];
  tags: string[];
  owners: string[];
  types: string[];
  statuses: MeetingStatus[];
}

// ---- Translation ----

/**
 * One language Recallix works in.
 *
 * The same list bounds what audio can be transcribed and what a brief can be
 * translated into — see the backend's `domain/Language` for why those are
 * currently the same eighteen, and why they need not stay that way. Fetched
 * rather than hard-coded here so the picker and the validation that rejects a
 * bad target cannot drift apart.
 */
export interface LanguageOption {
  /** ISO-639-1. */
  code: string;
  name: string;
  /** The endonym — "日本語" is what somebody scanning for their own language sees. */
  nativeName: string;
  rightToLeft: boolean;
}

/** A task in the reader's language, or in the original when the wording moved on. */
export interface TranslatedTask {
  id: string;
  title: string;
  ownerName?: string | null;
  dueDate?: string | null;
  /** False when the source was edited after this was made, so the title is the current original. */
  translated: boolean;
}

/** One utterance. Words only — speaker and timings come from the live segment. */
export interface TranslatedSegment {
  id: string;
  text: string;
}

/**
 * A meeting read in another language.
 *
 * Shaped like the untranslated brief so one component renders either. Two
 * absences are deliberate: no quotations, because a translated quote is a
 * paraphrase in quotation marks; and no transcript until `hasTranscript`, which
 * is the expensive half and is asked for separately.
 */
export interface MeetingTranslation {
  language: string;
  languageName: string;
  rightToLeft: boolean;
  shortSummary: string;
  detailedSummary: string;
  keyPoints: string[];
  sections: SummarySection[];
  actionItems: TranslatedTask[];
  segments: TranslatedSegment[];
  hasBrief: boolean;
  hasTranscript: boolean;
  /** The meeting changed after this was made. */
  stale: boolean;
  briefTranslatedAt?: string | null;
  transcriptTranslatedAt?: string | null;
}

/**
 * Something Recallix did while you were not looking.
 *
 * <p>Named `AppNotification` rather than `Notification` because the DOM already
 * owns that name globally, and shadowing it makes every `new Notification(...)`
 * in this codebase mean something unexpected.
 */
export interface AppNotification {
  id: string;
  kind: NotificationKind;
  kindLabel: string;
  /** The words written when it happened, not a template filled in now. */
  title: string;
  body: string | null;
  meetingId: string | null;
  actionItemId: string | null;
  link: string | null;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

export type NotificationKind =
  | "RECORDING_STARTED"
  | "PROCESSING_STARTED"
  | "TRANSCRIPT_READY"
  | "SUMMARY_READY"
  | "PROCESSING_FAILED"
  | "RECAP_SENT"
  | "ACTION_ITEM_DUE"
  | "ACTION_ITEM_OVERDUE"
  | "MENTIONED_IN_MEETING"
  | "SHARE_VIEWED";

/** One switch on the settings page, described by the server. */
export interface NotificationKindOption {
  kind: NotificationKind;
  label: string;
  /** Reads as "Tell me {setting}". */
  setting: string;
  /** False for the ones that cannot be switched off — currently only failures. */
  mutable: boolean;
}

export interface NotificationCount {
  unread: number;
  /** The STOMP topic suffix; the browser has never been told its own user id. */
  channel: string;
}

/** Where to fetch the original recording, and what to call it once it lands. */
export interface AudioDownload {
  url: string;
  filename: string;
  contentType: string | null;
  expiresInSeconds: number;
}

export interface AvailableTranslation {
  language: string;
  languageName: string;
  hasTranscript: boolean;
  stale: boolean;
  updatedAt: string;
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
/**
 * What a share link should reveal, for how long, and to whom it opens.
 *
 * Every field is optional: omitted means "leave it as it is" on an existing
 * link. `removePassword` and `neverExpires` exist because an absent value and an
 * explicit empty one arrive identically, and one means "don't touch it" while
 * the other means "take it off".
 */
export interface ShareCreateRequest {
  includeSummary?: boolean;
  includeActionItems?: boolean;
  includeTranscript?: boolean;
  includeAudio?: boolean;
  expiresInDays?: number;
  neverExpires?: boolean;
  password?: string;
  removePassword?: boolean;
  label?: string;
  /** Set together to share one excerpt rather than the whole meeting. */
  startSeconds?: number;
  endSeconds?: number;
  quote?: string;
}

export interface ShareResponse {
  id: string;
  token: string;
  url: string;
  label: string;
  includeSummary: boolean;
  includeActionItems: boolean;
  includeTranscript: boolean;
  includeAudio: boolean;
  /** Whether one is set — never the password itself. */
  passwordProtected: boolean;
  expiresAt?: string | null;
  /** Null for a whole-meeting link; set for an excerpt. */
  startSeconds?: number | null;
  endSeconds?: number | null;
  quote: string;
  viewCount: number;
  lastViewedAt?: string | null;
  createdAt: string;
}

/**
 * Mailing an existing link. Delivery, not access control — naming an address
 * grants it nothing, and the link works for whoever ends up holding it.
 */
export interface ShareEmailRequest {
  to: string[];
  message?: string;
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
  /**
   * Where that line sits in the recording. A selection already knows; an
   * extracted item's sentence has to be matched back to a segment server-side.
   */
  sourceStartSeconds?: number;
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
  /** Short-lived presigned media URL; absent unless the recording was shared. */
  audioUrl?: string | null;
  /** Set when the link points at one excerpt — the player and text are bounded. */
  startSeconds?: number | null;
  endSeconds?: number | null;
  quote?: string | null;
}

// ---- Privacy & data (V35) ----

/**
 * What Recallix holds, counted.
 *
 * No byte totals: getting them means a HEAD request per stored object, and the
 * number people actually want here is how many recordings of them exist, not
 * how many megabytes that came to.
 */
export interface HeldData {
  meetings: number;
  recordings: number;
  audioErased: number;
  transcripts: number;
  transcriptsErased: number;
  actionItems: number;
  marks: number;
  projects: number;
  chats: number;
  /** Meetings whose recorder confirmed the room had been told. */
  consentConfirmed: number;
  oldestMeetingAt: string | null;
}

/** The two dials, and what they would delete tonight. Null means keep. */
export interface RetentionPolicy {
  audioDays: number | null;
  meetingDays: number | null;
  recordingsDueNow: number;
  meetingsDueNow: number;
}

/**
 * How recordings are stored, reported rather than claimed.
 *
 * `encryptionAtRest` is read back from the object store and is null when it
 * applies none — the page says so instead of printing a reassuring sentence its
 * own infrastructure would contradict.
 */
export interface StorageFacts {
  encryptionAtRest: string | null;
  signedUrlSeconds: number;
  rowLevelSecurity: boolean;
}

/** One live share link, seen from the privacy page rather than from its meeting. */
export interface LiveLink {
  id: string;
  meetingId: string;
  meetingTitle: string;
  url: string;
  label: string;
  /** What it reveals, already collapsed into words a person can read. */
  reveals: string[];
  moment: boolean;
  passwordProtected: boolean;
  expiresAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  createdAt: string;
}

export interface PrivacyOverview {
  held: HeldData;
  retention: RetentionPolicy;
  storage: StorageFacts;
  liveLinks: LiveLink[];
}

/** Both dials every time: null means keep forever, not "leave this one alone". */
export interface RetentionUpdateRequest {
  audioDays: number | null;
  meetingDays: number | null;
}

/** The receipt for closing an account — the last thing Recallix can tell you. */
export interface AccountClosed {
  meetings: number;
  storedObjects: number;
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
  /** `OPEN_ANY` is everything unfinished — the default view. */
  status?: ActionItemStatus | "OPEN_ANY";
  priority?: Priority;
  /** A name, or `unassigned` for the ones nobody owns. */
  owner?: string;
  due?: "overdue" | "soon" | "dated" | "none";
  meetingId?: string;
  /** Matched against the display name in settings; empty until one is set. */
  mine?: boolean;
}
