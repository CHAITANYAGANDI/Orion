# Recallix AI — Shared Contracts

This document is the **single source of truth** shared by the three services
(`frontend/`, `backend-spring/`, `ai-service/`). All services MUST conform to
these contracts so they interoperate.

---

## 1. Service topology & ports

| Service        | Tech               | Port  | Base URL (local)          |
|----------------|--------------------|-------|---------------------------|
| frontend       | Next.js            | 3000  | http://localhost:3000     |
| backend-spring | Spring Boot        | 8080  | http://localhost:8080     |
| ai-service     | FastAPI            | 8000  | http://localhost:8000     |
| postgres       | Postgres 16        | 5432  | —                         |
| redis          | Redis 7            | 6379  | —                         |
| kafka          | Kafka (KRaft)      | 9092  | kafka:9092 (in-network)   |
| minio (S3)     | MinIO              | 9000  | http://localhost:9000     |

The frontend talks **only** to Spring Boot (`/api/v1/**`) and the WebSocket.
Spring Boot orchestrates FastAPI via Kafka. FastAPI calls back to Spring Boot's
internal callback endpoint to persist results (and also emits Kafka completion
events for observability).

---

## 2. Auth

- Auth provider: **Clerk**. Frontend obtains a Clerk session JWT.
- Every request to Spring `/api/v1/**` carries `Authorization: Bearer <clerk_jwt>`.
- Spring validates the JWT (issuer = Clerk frontend API, JWKS endpoint) and
  extracts `sub` as `clerk_user_id`. A local `users` row is upserted on first request.
- Internal callbacks from FastAPI -> Spring use a shared secret header
  `X-Internal-Token: <RECALLIX_INTERNAL_TOKEN>` (NOT a Clerk JWT).
- **Dev mode**: when `RECALLIX_AUTH_MODE=dev`, Spring accepts a header
  `X-Dev-User: <clerk_user_id>` instead of a real JWT, so the whole system runs
  without a Clerk account. Frontend sends this automatically when
  `NEXT_PUBLIC_AUTH_MODE=dev`.

---

## 3. Spring Boot REST API (`/api/v1`)

All responses are JSON. Error envelope:
```json
{ "timestamp": "2026-07-21T10:00:00Z", "status": 404, "error": "NOT_FOUND",
  "message": "Meeting not found", "path": "/api/v1/meetings/x", "correlationId": "..." }
```

Paginated list envelope:
```json
{ "content": [ ... ], "page": 0, "size": 20, "totalElements": 57, "totalPages": 3 }
```

### Meetings

A meeting's `sourceType` records how it arrived and changes what the response
carries:

| `sourceType` | How it arrives | Transcribed? | Has `segments`? |
|---|---|---|---|
| `AUDIO` | presigned upload, or the in-browser recorder | yes | yes |
| `YOUTUBE` | `POST /meetings/import` — the worker downloads it | yes | yes |
| `DOCUMENT` | presigned upload of `application/pdf` | no — text layer is read directly | no |

`DOCUMENT` meetings have no timeline, so `segments` is empty and transcript
deep-links (`?t=`) do not apply. `POST /meetings/import` accepts YouTube hosts
only; anything else is `400`, enforced before the event is published *and*
again in the worker.

| Method | Endpoint | Body / Query | Response |
|---|---|---|---|
| POST | `/api/v1/meetings/upload-url` | `{ "filename", "contentType", "sizeBytes" }` | `{ "meetingId", "uploadUrl", "objectKey", "expiresInSeconds" }` |
| POST | `/api/v1/meetings` | `MeetingCreateRequest` | `MeetingResponse` |
| POST | `/api/v1/meetings/import` | `{ "url", "title"?, "tags"? }` | `201 MeetingResponse` |
| GET  | `/api/v1/preferences` | — | `PreferencesResponse` |
| PATCH | `/api/v1/preferences` | `{ "autoEmailRecap"?, "recapEmail"? }` | `PreferencesResponse` |
| GET  | `/api/v1/meetings` | `?page&size&search&tag&status` | `Page<MeetingResponse>` |
| GET  | `/api/v1/meetings/{id}` | — | `MeetingResponse` |
| PATCH | `/api/v1/meetings/{id}` | `{ "title"?, "tags"? }` | `MeetingResponse` |
| GET  | `/api/v1/meetings/{id}/transcript` | — | `TranscriptResponse` |
| GET  | `/api/v1/meetings/{id}/summary` | — | `SummaryResponse` |
| GET  | `/api/v1/meetings/{id}/action-items` | — | `ActionItemResponse[]` |
| PATCH | `/api/v1/meetings/{id}/speakers` | `{ "mapping": { "Speaker 1": "Ana" } }` | `TranscriptResponse` |
| PATCH | `/api/v1/meetings/{id}/speakers/rematch` | `{ "fromSpeaker"?, "toSpeaker", "segmentIds"? }` | `TranscriptResponse` |
| POST | `/api/v1/meetings/{id}/reprocess` | — | `202 { "meetingId","status" }` |
| DELETE | `/api/v1/meetings/{id}` | — | `204` |

**Creating a meeting takes almost nothing.** `MeetingCreateRequest` is
`{ "objectKey", "title"?, "tags"?, "contentType"?, "durationSeconds"?,
"summaryTemplate"? }`. The title is set from the uploaded filename at presign
time, so `title` here is an override for clients whose filename is not a name —
the in-browser recorder, whose files are `recording-1755084000000.webm`. Blank
or absent keeps the filename.

Renaming and tagging happen afterwards, through `PATCH /meetings/{id}`, because
both are things you know after listening rather than before. On that endpoint a
`null`/absent field means *leave alone* and an empty `tags` array means *clear*
— without the distinction, removing the last tag would be inexpressible.

There is no `participants` field anywhere. Recallix never joins a meeting, so it
never learns who attended; the column only ever held what an uploader typed, and
was dropped in V23. Speaker labels on the transcript are the answer to "who was
here", and they come from the recording itself.

`TranscriptResponse` carries a `speakers[]` of talk-time stats
(`speaker`, `speakingSeconds`, `percentage`, `segmentCount`, `wordCount`),
derived from the segments on every read. The percentage is a share of total
**speaking** time, not of the meeting's wall-clock duration — the two differ
whenever there is silence, and percentages that do not sum to 100 read as a bug.

### Speaker rematch vs. rename

Renaming answers "who is Speaker 2?". Rematching fixes diarization itself, and
takes exactly one of two shapes — sending both is a `400`, because the result
would depend on which was applied first:

- **Merge** — send `fromSpeaker`. Every turn with that label becomes
  `toSpeaker`. For when one person was split across two labels; renaming both
  to the same name leaves the turns separate, so the transcript reads as though
  they interrupt themselves.
- **Reassign** — send `segmentIds`. Only those turns move. For a handover where
  two people overlap and the turn landed on the wrong one. An unknown segment id
  fails the whole batch rather than half-applying it.

Both re-index the meeting and rebuild the flat transcript, because each carries
the speaker prefix and chat and the export read them.

### Custom vocabulary & known speakers

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/v1/vocabulary` | — | `VocabularyTerm[]` |
| POST | `/api/v1/vocabulary` | `{ "term", "category", "expansion"?, "active"? }` | `201 VocabularyTerm` |
| PUT | `/api/v1/vocabulary/{id}` | same as POST | `VocabularyTerm` |
| DELETE | `/api/v1/vocabulary/{id}` | — | `204` |
| GET | `/api/v1/speakers` | — | `KnownSpeaker[]` |
| DELETE | `/api/v1/speakers/{id}` | — | `204` |

`category` is `KEYWORD | NAME | JARGON | ACRONYM`. All four become the same
boosting list on the transcription request — the category is what the user is
telling us, not a different mechanism — and `expansion` is stored for `ACRONYM`
only. Terms are hints, not rules: they raise the probability of a term being
recognised without forcing it. Duplicates (case-insensitive) and exceeding the
per-user cap are both `400` with a message worth showing verbatim.

Vocabulary is resolved by Spring when a job is enqueued and travels on the
`meeting_uploaded` event, so it applies to meetings processed **after** a term
is added — an existing transcript must be reprocessed to benefit. Each provider
expresses boosting differently: Deepgram nova-3+ takes `keyterm`, nova-2 and
earlier take `keywords`, AssemblyAI takes `word_boost`, and Whisper has no
boosting parameter so the terms go in its decoding `prompt`.

`/api/v1/speakers` has no create endpoint on purpose: the list is written by
renaming or rematching a speaker, so it reflects names actually in use rather
than a separate address book that would drift from the transcripts.

### Chat, semantic search & translation

RAG chat exists at two scopes. **Meeting-scoped** chat is grounded in one
transcript. **Workspace-scoped** chat is grounded across every meeting the caller
owns — its citations additionally carry `meetingId`/`meetingTitle`, so the UI can
deep-link to `/meetings/{id}?t={start}`.

| Method | Endpoint | Body | Response |
|---|---|---|---|
| GET | `/api/v1/meetings/{id}/chat` | — | `ChatMessageResponse[]` |
| POST | `/api/v1/meetings/{id}/chat` | `{ "question" }` | `ChatMessageResponse` |
| POST | `/api/v1/meetings/{id}/translate` | `{ "targetLanguage" }` | `TranslateResponse` |
| GET | `/api/v1/chat` | — | `ChatMessageResponse[]` (workspace conversation) |
| POST | `/api/v1/chat` | `{ "question", "meetingIds"? }` | `ChatMessageResponse` |
| DELETE | `/api/v1/chat` | — | `204` (clears workspace conversation) |
| POST | `/api/v1/search/semantic` | `{ "query", "limit"? }` | `SemanticSearchHit[]` |

Persistence note: `chat_messages.meeting_id` is `NULL` for workspace turns —
that is what distinguishes the two conversations.

### Summary templates

A template decides what a summary contains and the order it reads in. Eight of
them, defined once in `ai-service/app/templates.py` and served through
`GET /api/v1/summary-templates` — there is no templates table, because the copy
that matters is the one the prompt is built from.

| Slug | Name | Sections between the spine |
|---|---|---|
| `general` | General | Decisions |
| `detailed` | Detailed | Key points, Decisions, Risks, Open questions |
| `executive` | Executive | Impact, Decisions, Risks, Asks |
| `memo` | Memo | Purpose, Background, Discussion, Recommendation |
| `standup` | Standup | Yesterday, Today, Blockers |
| `interview` | Interview | Questions and responses, Observations |
| `one-on-one` | 1:1 | Topics, Feedback, Commitments |
| `team-meeting` | Team Meeting | Progress, Decisions, Open items |

Every template opens with **Overview** and closes with **Next steps → Key
quotations → Outline**. That spine is fixed so switching template never takes
away the summary someone was reading, and because quotations are only
trustworthy after `app/quotes.py` verifies them against the transcript — which
happens once, keyed on the `quotes` section, rather than per template.

General, Detailed and Executive overlap in sections and differ in *voice*: the
same meeting needs a different summary for the person catching up, the person
reconstructing it, and the person approving it. That difference lives in the
section instructions.

An unknown slug resolves to General rather than erroring, so a meeting
summarized under a since-removed template can still be re-summarized.

### Chat starter questions

The chips above a chat are generated from real material, not hard-coded. A fixed
list fails in the way that does not look like a bug: "What did we decide?" sits
on a meeting that decided nothing, and the same three chips on every page stop
being read after the second one.

The two have different lifetimes, which is why they are stored differently.

| | Meeting chat | Workspace chat |
|---|---|---|
| Generated from | that meeting's summary sections | recent meetings + open action items |
| Generated when | the summary is written | on request |
| Stored in | `meeting_summaries.suggestions_json` | `workspace_suggestions` (one row per user) |
| Delivered by | `SummaryResponse.suggestions` | `GET /api/v1/suggestions/workspace` |
| Refreshed by | re-summarize / reprocess | a new meeting, or 6 hours |

**A meeting's questions ride on its summary** rather than getting their own
endpoint: the page already loads the summary, and a second request would make
the chips appear after the chat they sit above. They are generated once because
a summary does not change on its own — regenerating per page view would buy an
identical answer for a model call each time.

**A workspace has no such moment.** There is no "workspace processed" event, and
the right questions change as meetings land, so they are generated on request
and cached. The cache is invalidated by a meeting arriving (suggestions naming
last week's meetings read as a system that has lost track) or by six hours
passing (otherwise a stable archive shows the same three questions for ever,
which is the hard-coded list with extra steps).

Material selection is in `ai-service/app/suggestions.py` and matters more than
the prompt does. Two rules: send the **summary, not the transcript** — a
transcript is mostly connective tissue and a model reading one picks a vivid
aside over the decision that took forty minutes — and **bound it hard**, since
these run per meeting and per workspace. The outline and quotations sections are
excluded: the outline is a chronological walkthrough, so questions drawn from it
come out as "what did Speaker 2 say at the start?".

**Empty is a valid response everywhere**, and never an error. A meeting still
processing, a new workspace, a summary too thin, or an ai-service outage all
return `[]`, and the UI falls back to its hand-written prompts in
`frontend/lib/chat-prompts.ts` — which are kept precisely because those are the
moments when the user has least context. Generation failure never fails the
thing it is attached to: a brief without chips is a working brief, and the
workspace cache serves whatever it last had.

### Decisions and risks (`meeting_insights`)

Populated by the worker, from the summary it has just written — **not** by a
second extraction pass. A separate pass produces a list that disagrees with the
summary sitting beside it on the page, and the reader has no way to tell which
to believe. Reading them out of the sections means the two are the same words.

Which sections count (see `ai-service/app/insights.py`):

| Kind | Sections | Templates that produce them |
|---|---|---|
| `DECISION` | `decisions` | General, Detailed, Executive, Team Meeting |
| `RISK` | `risks`, `blockers` | Detailed, Executive, Standup |

Three templates produce neither, deliberately. A **1:1** produces commitments,
which are already action items; an **Interview** produces observations about a
candidate; a **Memo** produces a recommendation, which is a proposal rather than
something the group settled. Recording any of the three as a decision would put
words into the record that nobody agreed to.

| Method | Endpoint | Body / Query | Response |
|---|---|---|---|
| GET | `/api/v1/meetings/{id}/insights` | — | `InsightResponse[]` (both kinds) |
| POST | `/api/v1/meetings/{id}/insights` | `{ "kind", "text" }` | `201 InsightResponse` |
| PATCH | `/api/v1/insights/{id}` | `{ "text" }` | `InsightResponse` |
| DELETE | `/api/v1/insights/{id}` | — | `204` |

Both kinds come back from one `GET` so the meeting page makes one request; two
could arrive out of step and render a meeting whose decisions and risks came
from different moments.

Rows are editable because they are not only shown on the page — workspace chat
is handed the decision record as the authority on what was agreed and when, so a
wrong row is a wrong answer rather than a cosmetic blemish. `edited` marks a row
a human owns; **a reprocess replaces the derived rows and keeps those**, because
a rewrite that discarded corrections would bring the same wrong decision back
every time somebody fixed it.

`kind` is set on create and ignored on update: turning a decision into a risk is
not an edit, it is a different row.

### Action items
| Method | Endpoint | Body | Response |
|---|---|---|---|
| GET | `/api/v1/action-items` | `?page&size&status&priority` | `Page<ActionItemResponse>` |
| PATCH | `/api/v1/action-items/{id}` | `{ ownerName?, dueDate?, priority?, status? }` | `ActionItemResponse` |

### Billing & usage
| Method | Endpoint | Body | Response |
|---|---|---|---|
| POST | `/api/v1/billing/checkout` | `{ "plan": "PRO"\|"PREMIUM" }` | `{ "checkoutUrl" }` |
| POST | `/api/v1/billing/webhook` | Stripe event (raw) | `200` |
| GET  | `/api/v1/usage` | — | `UsageResponse` |

### Internal callback (FastAPI -> Spring, `X-Internal-Token`)
| Method | Endpoint | Body | Purpose |
|---|---|---|---|
| POST | `/internal/meetings/{id}/status` | `{ "status", "progress", "message" }` | Push status; Spring relays to WS + Redis |
| POST | `/internal/meetings/{id}/result` | `MeetingBriefResult` | Persist transcript/summary/actions/decisions/risks |

### Health
- Spring: `GET /actuator/health`
- FastAPI: `GET /health`

---

## 4. FastAPI AI API

Base: `http://ai-service:8000`

| Method | Endpoint | Input | Output |
|---|---|---|---|
| POST | `/ai/transcribe` | `{ "audioUrl" }` or `{ "audioPath" }` | `{ "transcript", "language", "segments":[{start,end,speaker,text}] }` |
| POST | `/ai/summarize` | `{ "transcript", "templateSlug"?, "durationSeconds"?, "speakerCount"? }` | `{ "shortSummary","detailedSummary","keyPoints":[],"sections":[],"templateSlug","insights":[Insight] }` |
| POST | `/ai/extract-action-items` | `{ "transcript" }` | `{ "actionItems":[ActionItem] }` |
| POST | `/ai/suggestions/workspace` | `{ "userId" }` | `{ "suggestions":["..."] }` |
| GET  | `/ai/templates` | — | `SummaryTemplate[]` (with section instructions) |
| POST | `/ai/process-meeting` | `{ "meetingId","audioUrl" }` | `MeetingBriefResult` (also persisted via callback) |
| POST | `/ai/chat` | `{ "meetingId","question" }` | `{ "answer","citations":[Citation] }` |
| POST | `/ai/workspace-chat` | `{ "userId","question","meetingIds"? }` | `{ "answer","citations":[Citation] }` |
| POST | `/ai/semantic-search` | `{ "userId","query","limit"? }` | `{ "hits":[SemanticSearchHit] }` |
| POST | `/ai/translate` | `{ "text","targetLanguage" }` | `{ "text","targetLanguage" }` |
| GET  | `/health` | — | `{ "status":"ok","provider":"openai\|mock" }` |

`/ai/summarize` returns `insights` as well as `sections`, derived from those
sections here rather than by the caller. Spring's re-summarize path persists
them, replacing the previously derived rows: a template switch changes the notes,
so leaving the old decisions would put the store and the summary in
disagreement. The key-to-kind mapping lives only in `app/insights.py` — a second
copy in Java would drift from the templates it reads.

Retrieval on the two workspace endpoints filters on `user_id`, which is
denormalised onto `transcript_chunks` (migration `V3`). Cross-tenant grounding is
therefore impossible even if a caller passes meeting ids they do not own.

### Date-aware workspace retrieval

`/ai/workspace-chat` reads a time window out of the question before retrieving
(`app/timeframe.py`). "What changed since last week?" is a question about a
period, and nearest-neighbour search has no notion of one — unfiltered it would
answer from whichever passages sit closest in embedding space, quite possibly
from March.

* Windows **roll backwards from now**: "last week" is the last 7 days, not
  Monday-to-Sunday. A calendar reading puts yesterday's meeting outside "last
  week", which is never what the asker means. `today` and `yesterday` are the
  exceptions, and named months (`in March`, `since March`) are calendar-anchored.
* Filtering happens **in SQL**, not after retrieval. Post-filtering takes the
  top-k of the whole archive and discards most of it, leaving a "last week"
  question answering from whatever two chunks survived.
* A question phrased as a comparison ("changed", "since", "versus", "progress")
  additionally retrieves the meetings *before* the window, labelled as
  comparison-only. Without both halves there is nothing to have changed from,
  and the model fills the gap by asserting everything is new. The two halves
  split one top-k budget and meet at exactly one boundary, so no passage is
  quoted as both recent and earlier.
* Every passage is labelled with its meeting **and date**, which is what lets an
  answer say which of two contradictory statements came later.

Workspace answers are also prefixed with two ledgers that retrieval cannot
supply: current action-item status (a transcript records what was promised, never
what happened next) and the decision record with dates (two contradictory
decisions six weeks apart are unlikely to both land in one top-k).

### Lookups vs inventories

Both chat endpoints classify the question before generating (`app/questions.py`)
and answer under one of two briefs. The **context is identical either way** —
this is not a retrieval switch.

| Kind | Example | Brief |
|---|---|---|
| Lookup | "What did we decide about pricing?" | Concise and specific |
| Inventory | "What hasn't been completed?" | Every item, one bullet each, never merged, ending `Total: N.` |

The ledger already contains every action item, so an inventory question never
failed for want of evidence — it failed at the writing. Told to be concise, the
model does what a person would and merges near-identical items: fifteen tracked
items came back as thirteen bullets. Complete, and impossible to count against
the Action items page.

**Composition beats enumeration.** "Draft an agenda from what was left open"
contains list words and is not a list request; any question asking for something
to be *written* stays prose. The asymmetry is deliberate — a missed inventory
gives the old merged answer, while a false positive staples `Total: 6.` to the
bottom of an email somebody is about to forward.

Above `_MAX_COMMITMENTS` (60) the ledger truncates, dropping DONE before OPEN.
The exhaustive brief tells the model to say the list may be incomplete rather
than imply otherwise, but that path is untested against real data.

---

## 5. Canonical JSON shapes (used by ALL services)

```jsonc
// ActionItem
{ "taskTitle": "Finish JWT validation", "ownerName": "Chaitanya",
  "dueDate": "Friday", "priority": "high|medium|low",
  "sourceSentence": "Chaitanya will finish JWT validation by Friday." }

// Insight — a decision or a risk, READ OUT OF the sections below rather than
// extracted separately. `sourceSection` names where it came from, which is what
// keeps a blocker distinguishable from a risk once both are stored as RISK.
{ "kind": "DECISION|RISK",
  "text": "Ship on the 14th, not the 7th.",
  "sourceSection": "decisions" }

// Quotation — verified against the transcript before it gets here; `speaker`
// and `start` come from the matched segment, not from the model.
{ "text": "we are not shipping on the 7th", "speaker": "Ana", "start": 412.5 }

// MeetingBriefResult (FastAPI -> Spring callback + /ai/process-meeting response)
{ "meetingId": "mtg_123",
  "transcript": "full text ...",
  "language": "en",
  "segments": [ { "start": 0.0, "end": 3.2, "speaker": "S1", "text": "..." } ],
  "shortSummary": "...",
  "detailedSummary": "...",
  "keyPoints": [ "..." ],
  "sections": [ /* SummarySection, in template order */ ],
  "templateSlug": "general",
  "quotes": [ /* Quotation */ ],
  "insights": [ /* Insight */ ],
  "actionItems": [ /* ActionItem */ ] }
```

### SummaryResponse (Spring -> frontend)
```jsonc
{ "meetingId": "mtg_123",
  "shortSummary": "...", "detailedSummary": "...", "keyPoints": [ "..." ],
  "sections": [ /* SummarySection */ ], "quotes": [ /* Quotation */ ],
  "templateSlug": "general",
  "stale": false }
```
`stale` is true once the transcript has been edited — by a segment correction, a
speaker rename or a rematch — after this summary was written. **The summary is
not regenerated automatically.** One model call per typo fix, and per each of the
next nineteen, is not a trade worth making, so the flag surfaces the choice
instead of making it; the UI shows a banner with the rewrite action. Writing a
summary (re-summarize, reprocess) clears it.

### MeetingResponse (Spring -> frontend)
```jsonc
{ "id": "mtg_123", "title": "Sprint Planning", "status": "READY",
  "tags": ["sprint"],
  "audioUrl": "https://...", "durationSeconds": 1830,
  "createdAt": "2026-07-21T10:00:00Z" }
```
`status` enum: `CREATED, UPLOADED, QUEUED, TRANSCRIBING, SUMMARIZING, EXTRACTING, READY, FAILED`.

### UsageResponse
```jsonc
{ "plan": "FREE", "periodStart": "...", "periodEnd": "...",
  "meetingsUsed": 3, "meetingsLimit": 5,
  "aiMinutesUsed": 42, "aiMinutesLimit": 60 }
```
Plan limits: FREE {meetings:5, minutes:60}, PRO {50, 600}, PREMIUM {unlimited=-1}.

---

## 6. Kafka topics (JSON values, key = meetingId)

| Topic | Produced by | Consumed by | Payload |
|---|---|---|---|
| `meeting_uploaded` | Spring | FastAPI | `{ meetingId, userId, audioUrl, objectKey }` |
| `transcription_started` | FastAPI | Spring | `StatusEvent` |
| `transcription_completed` | FastAPI | Spring | `StatusEvent` |
| `summary_generated` | FastAPI | Spring | `StatusEvent` |
| `action_items_extracted` | FastAPI | Spring | `StatusEvent` |
| `meeting_processing_failed` | FastAPI | Spring | `{ meetingId, error }` |
| `payment_successful` | Spring | Spring | `{ userId, plan }` |
| `usage_limit_reached` | Spring | Spring | `{ userId }` |

`StatusEvent`:
```jsonc
{ "meetingId": "mtg_123", "status": "TRANSCRIBING", "progress": 45,
  "message": "Generating transcript from audio..." }
```

---

## 7. WebSocket (Spring -> frontend)

- STOMP over SockJS at `ws://localhost:8080/ws`.
- Client subscribes to `/topic/meetings/{meetingId}`.
- Server pushes `StatusEvent` payloads.
- Also mirrored into Redis key `meeting:status:{meetingId}` (TTL 1h) for polling fallback
  via `GET /api/v1/meetings/{id}` (status field) — no extra endpoint needed.

---

## 8. Phase 2 (Agent + MCP) — scaffolded, not wired to live providers

Endpoints exist and return draft plans; external execution is stubbed with an
approval workflow. See `docs/phase2-agent-mcp.md`.
