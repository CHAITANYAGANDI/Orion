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
| PATCH | `/api/v1/preferences` | `{ "autoEmailRecap"?, "recapEmail"?, "displayName"?, "taskReminders"? }` | `PreferencesResponse` |
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

| Method | Endpoint | Body / Query | Response |
|---|---|---|---|
| GET | `/api/v1/meetings/{id}/chat` | `?conversationId` | `ChatMessageResponse[]` |
| POST | `/api/v1/meetings/{id}/chat` | `{ "question", "conversationId"? }` | `ChatMessageResponse` |
| DELETE | `/api/v1/meetings/{id}/chat` | — | `204` (every thread on this meeting) |
| GET | `/api/v1/chat` | `?conversationId` | `ChatMessageResponse[]` |
| POST | `/api/v1/chat` | `{ "question", "meetingIds"?, "conversationId"? }` | `ChatMessageResponse` |
| DELETE | `/api/v1/chat` | — | `204` (every workspace thread) |
| POST | `/api/v1/search/semantic` | `{ "query", "limit"? }` | `SemanticSearchHit[]` |

Persistence note: `chat_messages.meeting_id` is `NULL` for workspace turns —
that is what distinguishes the two scopes.

### Translation
| Method | Endpoint | Body | Response |
|---|---|---|---|
| GET | `/api/v1/languages` | — | `LanguageResponse[]` |
| GET | `/api/v1/meetings/{id}/translations` | — | `Available[]` |
| POST | `/api/v1/meetings/{id}/translations` | `{ targetLanguage, includeTranscript? }` | `TranslationResponse` |
| GET | `/api/v1/meetings/{id}/translations/{language}` | — | `TranslationResponse` |
| DELETE | `/api/v1/meetings/{id}/translations/{language}` | — | `204` |

**Eighteen languages, and the asymmetry behind that number.** Transcription runs
on AssemblyAI's Universal-3.5 Pro, which supports eighteen spoken languages — so
a meeting held in Telugu is not transcribable at all, and no amount of
translation downstream fixes that, because there is nothing to translate.
Translation itself is not so limited; the provider supports a hundred-odd
targets, and an English meeting could in principle be read in Telugu. Offering
that today would mean one picker holding two very different lists and a rule
nobody can keep in their head, so **the target list is the same eighteen**.
Widening it is adding entries to `domain/Language` and a flag saying which side
they belong to; nothing else changes. `GET /languages` is the single source —
the browser's picker and the validation that rejects a bad target read the same
list, and `targetLanguage` accepts a code, an English name or an endonym while
storage is always the bare two-letter code.

**A translation is stored, not recomputed.** A brief is a few hundred words; an
hour of speech is several thousand across hundreds of utterances, and costs real
money and tens of seconds. So `meeting_translations` (V33) holds one row per
meeting per language, and `POST` is idempotent: asking again returns what is
stored without spending a model call, which is what lets the client fire it on
every language switch without tracking what exists.

**The two halves are translated separately.** Choosing a language does the
brief — summary, key points, **sections** and action items. `includeTranscript`
is opt-in because doing it for everyone who switched language to read a summary
spends their money on a tab they never opened. `hasBrief` / `hasTranscript` say
which exist rather than leaving the reader to infer it from an empty list.

**Alignment is the contract, not translation quality.** `/ai/translate-lines`
takes a list and returns one of exactly the same length in the same order —
key points, bullets, tasks and utterances are all lists whose positions carry
meaning. A reply one item short does not degrade gracefully: it slides every
line up by one and puts one speaker's words under another's name, which reads as
a quotation from somebody who never said it. Chunks are validated individually
and fall back to their own source lines, so partial translation is a real and
deliberately visible outcome — and it is checked again in `AiClient` and again
in the route, because the cost of being wrong is silent misattribution.

**What is never translated.** Quotations, because a quote claims to be the exact
words somebody said and a translated quote is a paraphrase in quotation marks.
A section's `key` and `kind`, which the renderer switches on rather than reads.
People's names. And a task whose wording was corrected after the translation was
made — `TranslatedTask.sourceTitle` is compared against the live title, and a
mismatch shows the current original with `translated: false` rather than a
translation of a sentence that has been replaced.

**Staleness** works as V25's does, one layer further out: editing a transcript,
rewriting a summary or reprocessing marks every translation of that meeting
stale, and nothing is re-translated automatically — that would be one model call
per language behind a one-word correction. Refreshing a stale brief **drops the
stored transcript translation** unless the transcript is refreshed too, because a
translation that is half up to date has no truthful flag to fly.

**The translated transcript is read-only in the UI.** Correcting, highlighting
and quoting all record exact words or character offsets; running any of them
against translated text saves something that was never said — a "correction"
that overwrites the recording's own words, a highlight pointing into a sentence
nobody spoke. The reading view says where to go to edit.

### Sharing

| Method | Endpoint | Body | Response |
|---|---|---|---|
| POST | `/api/v1/meetings/{id}/share` | `ShareCreateRequest` | `ShareResponse` |
| GET | `/api/v1/meetings/{id}/share` | — | `ShareResponse` or `204` |
| GET | `/api/v1/meetings/{id}/share/links` | — | `ShareResponse[]` |
| DELETE | `/api/v1/meetings/{id}/share` | — | `204` |
| DELETE | `/api/v1/shares/{shareId}` | — | `204` (one link) |
| POST | `/api/v1/meetings/{id}/share/email` | `{ "to": [], "message"? }` | `{ "sent": n }` |
| GET | `/public/shared/{token}` | header `X-Share-Password` | `SharedMeetingResponse` |

**There are no roles, and there cannot be.** Viewer, commenter and editor
describe what a *person* may do, which presumes an account to attribute the
writing to and to check on the next request. Everyone holding a link is the same
anonymous reader. So what varies is not permission but **content**: four
switches (`includeSummary`, `includeActionItems`, `includeTranscript`,
`includeAudio`) saying what is visible. Summary and action items default on; the
transcript and the recording default off, and the recording more firmly — a
summary is a written account somebody can stand behind, the recording is
everyone's unedited voice.

**Omitted means "leave it alone".** `neverExpires` and `removePassword` exist
because an absent value and an explicit empty one arrive identically, and one
means "don't touch it" while the other means "take it off" — the same problem as
unfiling a meeting from a project.

**Password** (V31) is a bcrypt hash and is never returned; `passwordProtected` is
a boolean. It is the second factor for a link that has leaked but not been
noticed — the only control that helps *after* a URL is somewhere it should not
be, since revoking requires knowing. The work factor is also the rate limit. It
travels in a header rather than the query string, because a URL is written to
server logs, browser history and every proxy in between. A wrong password is not
counted as a view.

**Moment links** carry `startSeconds`/`endSeconds` and clip the transcript to
that range **in the query**, not in the browser — sending the whole hour and
hiding all but ten seconds is not sharing a moment. They are always new rather
than idempotent: folding the second into the first would silently re-point a URL
somebody already holds. `quote` is denormalised so a link keeps showing what was
shared after a reprocess replaces the segments underneath it. At most one live
whole-meeting link per meeting; as many moment links as there are moments.

**Audio** is a short-lived presigned URL, generated only when the dial is on —
not merely filtered out of the payload, so there is no signed URL in a log for
anyone to lift.

**Email is delivery, not access control.** Naming an address grants it nothing;
the link works for whoever ends up holding it. The endpoint sends an existing
link and refuses to create one, because an endpoint that both publishes a meeting
and posts the URL to arbitrary addresses is one mistaken click from a leak. The
mail says a password will be needed and never carries the password.

Resolution failures stay indistinguishable: an invalid token, a revoked one and
an expired one are all the same 404. Only "this link wants a password" is
admitted, and only as a 401 — anyone holding the token knows that much already.

### Exports

| Method | Endpoint | Query | Response |
|---|---|---|---|
| GET | `/api/v1/meetings/{id}/export` | `format`, `transcript?`, `language?`, `tz?` | the file, `Content-Disposition: attachment` |
| GET | `/api/v1/meetings/{id}/audio` | — | `AudioDownloadResponse` |

`format` is `pdf`, `docx`, `md` or `txt`, and also accepts `word`, `markdown`
and `text` because the button says "Word (.docx)". Anything else is a 400 naming
what is on offer.

**One document, four renderings.** `ExportService` builds an `ExportDocument` —
title, spec line, and a short sealed set of blocks (heading, prose, bullets,
tasks, transcript, aside) — and each renderer only decides how to draw it. All
the deciding happens once: which parts go in, that an empty section keeps its
heading with "Not discussed." under it, that a finished task stays in the list,
that a deadline keeps the words somebody actually used. Previously the markdown
export lived in the browser and the "PDF" was `window.print()`, and the two
disagreed about most of that.

**The transcript is opt-in.** It is ten to a hundred times the length of
everything else, and somebody exporting a PDF to attach to an email wants the
two pages rather than the forty.

**Exporting a translation does not translate anything.** A download is a GET;
`?language=es` reads a translation that already exists and 404s otherwise,
pointing at `POST /translations`. In the app the reader has already switched the
page into that language, which is what created it — and the export follows what
is on screen rather than offering a second language choice that could silently
disagree with it. Recallix's own headings ("Action items", "Transcript", "Not
discussed.") are translated from a table in `ExportLabels`; the section titles
come from the template and were translated with the brief.

**PDF is where the eighteen languages cost something.** A DOCX names a font and
Word finds one; a PDF that names a font the reader lacks draws empty boxes. So
Noto Sans is embedded and subset for the thirteen Latin-script languages, Noto
Sans Arabic / Hebrew / Devanagari for those three, and Japanese and Chinese
reference the Adobe character collections that ship with OpenPDF — not embedded,
which is why this repository does not carry a sixteen-megabyte font. Every run
goes through a `FontSelector` holding the script font then Noto Sans, because
Noto Sans Arabic has no letter A and an Arabic export would otherwise render
"Stripe" as blanks. Right-to-left is a run direction on the writer and on each
paragraph, which is also what joins the Arabic letters. **Known limit:**
Devanagari needs conjunct formation and vowel reordering, which OpenPDF does not
do — Hindi is legible but not correctly typeset, and a readable file beats
refusing to export Hindi at all.

**DOCX is written directly.** A `.docx` is a zip of five XML parts and this
renderer emits a linear document; Apache POI would be ~20 MB of jars for a
grammar entirely used in `DocxRenderer`. Bullets are real list items and headings
are heading styles, so the file is something to rewrite rather than a wall of
indented text. Zip entry times are fixed, so exporting an unchanged meeting twice
gives the same bytes.

**Filenames.** The stem is the meeting title reduced to letters and digits —
letters, not ASCII letters, so a Japanese title downloads as itself. The header
carries both spellings: `filename*=UTF-8''…` per RFC 5987 and a stripped plain
`filename` for older clients. `Content-Disposition` is in the CORS
`exposedHeaders`, without which the browser hides it cross-origin and every file
lands under a fallback name.

**Audio is a presigned link, not bytes through the API.** The recording is the
largest thing Recallix stores, and proxying it to add nothing would tie up a
request thread for the length of a download. The disposition is signed into the
URL — the HTML `download` attribute is ignored cross-origin, so this is the only
thing that makes the browser save `sprint-planning.mp3` instead of opening an
object key. Asked for on click rather than with the meeting, because it expires.
A `DOCUMENT` source has no recording and says so with a 400.

### Notifications (V34)

| Method | Endpoint | Body / Query | Response |
|---|---|---|---|
| GET | `/api/v1/notifications` | `page`, `size`, `unread?` | `Page<NotificationResponse>` |
| GET | `/api/v1/notifications/unread-count` | — | `{ unread, channel }` |
| GET | `/api/v1/notifications/kinds` | — | `NotificationKindResponse[]` |
| POST | `/api/v1/notifications/{id}/read` | — | `NotificationResponse` |
| POST | `/api/v1/notifications/{id}/unread` | — | `NotificationResponse` |
| POST | `/api/v1/notifications/read-all` | — | `{ unread, channel }` |
| DELETE | `/api/v1/notifications/{id}` | — | `204` |
| DELETE | `/api/v1/notifications` | — | `204` |
| POST | `/api/v1/recordings/started` | — | `202` |

**Ten kinds, emitted from events that already existed.** `RECORDING_STARTED`,
`PROCESSING_STARTED`, `TRANSCRIPT_READY`, `SUMMARY_READY`, `PROCESSING_FAILED`,
`RECAP_SENT`, `ACTION_ITEM_DUE`, `ACTION_ITEM_OVERDUE`, `MENTIONED_IN_MEETING`,
`SHARE_VIEWED`. Before this, all of it happened in the log: the only feedback
surface was the live status socket on one meeting page, so closing the tab meant
the product had nothing to say about the twenty minutes it spent working.

**What a one-account product cannot notify about.** Recallix has no teams,
members or invitations, so there is no "someone" to comment, to mention you or to
share a meeting with you. Two of those three have real counterparts and are here
under honest names: `MENTIONED_IN_MEETING` is a meeting assigning work to you
**by name** — matched on `users.display_name`, with no display name meaning no
notification, because a guess tells somebody they owe work they never agreed to —
and `SHARE_VIEWED` is somebody outside opening a link you published, which is
the only genuinely other-party event the product has. A comment from another
person has no counterpart: action item notes are a private working log.

**`PROCESSING_FAILED` is on nobody's list and is the one people need.** An upload
that failed while the tab was closed is otherwise indistinguishable from one
still running. It is the single kind that cannot be muted — `mutable: false` —
because switching it off makes "nothing happened" and "something broke" the same
silence.

**Transcript and summary are one arrival.** The worker returns transcript, notes
and action items in a single result callback, so both would fire at the same
instant with the same link. `CallbackService.announce` emits the summary when
there is one and the transcript only when that is all there is — notes imply a
transcript, and ringing twice for one event is how a bell stops being read.

**Muting is a list of what is off** (`users.muted_notifications`), so everything
is on by default and a kind added later ships enabled rather than invisible. A
muted kind is **never written**, not filtered on read: filtering at render time
means switching a kind back on floods the bell with a month of things somebody
had already decided they did not want.

**Deduplication** is a unique index on `(user_id, kind, dedupe_key)`. An overdue
task is overdue again tomorrow, a link shared with forty people is opened forty
times, and a recording started three times while finding a quiet room is one
decision. Keys are `day:{date}` for the deadline pair, `share:{id}:{date}`,
`hour:{epoch-hour}` for recordings and `meeting:{id}` for mentions.

**Deadlines notify everybody, not just the email subscribers.** `TaskReminderJob`
now runs two passes: `sendDue` mails the people who opted in, `notifyDue` writes
a bell row for everyone with work outstanding. Mailing somebody who did not ask
is spam; a row in their own list is not, and the audiences are genuinely
different.

**Share views are an event, not a call.** `ShareService.resolve` publishes
`ShareViewedEvent`; `ShareViewListener` consumes it after commit on another
thread, sets the tenant (the share page is unauthenticated) and writes the
notification. Inside the request it would be a public page failing on a
dedupe-key collision, which is what forty simultaneous readers produce.

**Nothing here may break what it reports on.** `NotificationService.emit`
swallows everything and logs — a meeting that processed correctly must not be
reported as failed because the sentence about it could not be written down.

### Projects (V30)

| Method | Endpoint | Body | Response |
|---|---|---|---|
| GET | `/api/v1/projects` | — | `ProjectResponse[]` (with `meetingCount`) |
| GET | `/api/v1/projects/unfiled` | — | `MeetingResponse[]` |
| GET | `/api/v1/projects/{id}` | — | `ProjectResponse` |
| GET | `/api/v1/projects/{id}/meetings` | — | `MeetingResponse[]` |
| POST | `/api/v1/projects` | `{ "name", "description"?, "color"? }` | `201 ProjectResponse` |
| PATCH | `/api/v1/projects/{id}` | same, all optional | `ProjectResponse` |
| DELETE | `/api/v1/projects/{id}` | — | `{ "unfiledMeetings": n }` |
| PUT | `/api/v1/projects/meetings/{meetingId}` | `{ "projectId": id \| null }` | `MeetingResponse` |

**A project is not a folder**, and the difference is the feature: it is a thing
that is happening, which is what makes "ask Recallix about this project" a
sensible sentence. The chat below is the point of the table; the grouping is how
it knows what to read.

**One project per meeting**, on `meetings.project_id`. Tags remain the
many-to-many — a second one would leave two answers to "how do I group these",
and a tree cannot draw a meeting under three parents. **No nesting**: no
`parent_id`, deliberately, because sub-projects cost a recursive read on every
list and a move-loop check on every rename for a hierarchy nobody in a
single-person workspace is deep enough to need.

**Deleting a project never deletes meetings.** `ON DELETE SET NULL` on the
meeting, plus an explicit unfile in the service so the count can be returned:
somebody tidying a sidebar is not asking to destroy six hours of audio. The
opposite call for conversations (`ON DELETE CASCADE`) — a thread about a project
that no longer exists is answers about meetings that are no longer grouped,
reachable from nowhere.

Assignment is its own endpoint rather than a field on `PATCH /meetings/{id}`,
which leaves omitted fields alone: Jackson cannot tell an omitted `projectId`
from one explicitly `null`, and "take it out of its project" is exactly the
second case. `POST /meetings` also accepts `projectId`, so an upload can be
filed as it arrives.

### Project chat

| Method | Endpoint | Body / Query | Response |
|---|---|---|---|
| GET | `/api/v1/projects/{id}/chat` | `?conversationId` | `ChatMessageResponse[]` |
| POST | `/api/v1/projects/{id}/chat` | `{ "question", "conversationId"? }` | `ChatMessageResponse` |
| GET | `/api/v1/projects/{id}/chat/conversations` | — | `ConversationResponse[]` |
| POST | `/api/v1/projects/{id}/chat/conversations` | — | `201 ConversationResponse` |
| DELETE | `/api/v1/projects/{id}/chat` | — | `204` (every thread on this project) |

Retrieval is the workspace's, narrowed to the project's meeting ids — resolved
server-side, because what a project contains is a fact about the database and
not something a client should assert.

**An empty project is answered without a model call.** Downstream an empty id
list means "do not filter", so passing one would answer a question about this
project from every meeting in the workspace and present it as the project's.

**Scope is now a value, not a nullable column** (`ChatScope`). Two scopes fitted
into "meeting id set or null"; three do not. Left as it was, a project thread
and a workspace thread would both be "no meeting" — the workspace history would
list every project's threads, and clearing it would delete them. A database
constraint enforces the exclusion: `meeting_id IS NULL OR project_id IS NULL`.

### Workspace search

| Method | Endpoint | Query | Response |
|---|---|---|---|
| GET | `/api/v1/search` | see below | `SearchResponse` |
| GET | `/api/v1/search/facets` | — | `SearchFacets` |

`?q` plus `groups`, `limit`, `offset` and the filters `from`, `to`, `status`,
`type`, `tag`, `project`, `speaker`, `owner`, `withDecisions`. Absent filters are the empty
string, not `null`: these become parameters in native SQL, where an untyped null
fails to plan rather than failing to match.

**One request, six groups.** `SearchResponse` carries `meetings`, `people`,
`decisions`, `risks`, `commitments` and `mentions`, each `{ total, hits[] }`.
The counts are the interface — "27 transcript mentions, 0 decisions" is what
tells a reader the term lives in the recordings and that nothing was settled
about it — so each query counts its full result set with `COUNT(*) OVER ()` and
returns a page of it. Five separate requests would render five counts at five
different moments, each carrying the same filters, and a filter change would be
five chances to disagree.

Naming `groups` asks for one group deeply (`?groups=mentions&limit=50`), which
is what "see all 27" does rather than re-running four queries it will not show.

| Group | Read from |
|---|---|
| meetings | `meetings.title`, its tags, **and** matching utterances inside it |
| people | `transcript_segments.speaker` ∪ `meeting_action_items.owner_name` ∪ `known_speakers` |
| decisions / risks | `meeting_insights`, by `kind` |
| commitments | `meeting_action_items` |
| mentions | `transcript_segments.text` |

Two of those need saying out loud. **A commitment is an action item** — there is
no second store, and deliberately: the ai-service excludes a template's
Commitments section from the insight pass precisely so a promise is not recorded
twice, once where its state is tracked and once where it is not.

And **a person is not an account**: Recallix has one user per workspace, so
`people` is names, from three places. Diarized speakers alone would list
everyone who talked and nobody who was talked about — search a name that owns
three commitments and is said in nine sentences, and a speakers-only query
answers "no such person". So the union, counted three ways (`segments`,
`mentions`, `commitments`), and a row is only returned if one of the three is
non-zero inside the current filters.

Only `mentions` is served by an index (V29: a generated `search_tsv`, config
`simple`, GIN). The other four tables hold tens of rows per user, where the
index lookup costs more than the scan. `simple` rather than `english` because
the archive is multilingual and because prefix matching — `stripe:*` from the
third keystroke — is impossible under a stemmer.

**What a "meeting type" is:** the summary template the meeting is written in
(1:1, standup, interview). There is no second type field, and adding one would
leave two answers to the same question. **There is no participant filter
separate from speaker:** V23 dropped the participants table, so the only record
of who was in a meeting is who spoke in it. **`project` takes a project id or
the literal `none`** for meetings filed nowhere — "what have I not sorted yet" is
a real question, and one nobody can ask by picking a project from a list.

### Playback

No endpoints — it is worth a note anyway, because the player's least obvious
features are read out of the transcript rather than out of the audio.

| Control | Source |
|---|---|
| skip silence | gaps between `transcript_segments`, ≥ 1s |
| next / previous speaker | the next segment whose `speaker` differs |
| play highlights only | `transcript_moments` spans, merged |
| coloured seek bar | speaker turns over the meeting's duration |

Recallix already knows to the word who spoke and when, so a gap between
utterances **is** the silence and a change of speaker **is** the boundary.
Deriving them is exact and free; an amplitude implementation would need the
samples decoded in the browser and would still guess at the quiet parts of
speech. The logic is pure and time-based in `frontend/lib/playback.ts`, which is
the only way it is testable — jsdom has no playback.

**A true amplitude waveform is not implemented.** It needs a peaks array
computed in the worker and stored on the meeting; decoding a 100 MB MP3 in the
browser to draw it would jank badly. The speaker-banded seek bar covers most of
what a waveform is read for on a meeting recording — where each person talks,
and where nobody does.

### Chat history (`chat_conversations`)

Both scopes are organised into named threads (V28). Before it, each scope was
one unbounded conversation, which made "clear it all" the only tidying control
available — so clearing became the thing people did, throwing away the record
that made storing it worthwhile.

| Method | Endpoint | Body | Response |
|---|---|---|---|
| GET | `/api/v1/meetings/{id}/chat/conversations` | — | `ConversationResponse[]` |
| POST | `/api/v1/meetings/{id}/chat/conversations` | — | `201 ConversationResponse` |
| GET | `/api/v1/chat/conversations` | — | `ConversationResponse[]` |
| POST | `/api/v1/chat/conversations` | — | `201 ConversationResponse` |
| PATCH | `/api/v1/chat/conversations/{id}` | `{ "title" }` | `ConversationResponse` |
| DELETE | `/api/v1/chat/conversations/{id}` | — | `204` |
| DELETE | `/api/v1/chat/messages/{id}` | — | `204` (the exchange) |

Renaming and deleting take no scope: a conversation id already says which chat
it belongs to. Listing and creating do, because a scope is what they enumerate.

**Omitting `conversationId` when asking is the normal case.** It continues
whichever thread was last used at that scope, or starts one — the chat box is
the primary control on the page, and a first-time user has no thread yet. The
response carries the `conversationId` the turn was actually filed under, which
is the only way the client learns which thread it just continued.

**Scope is enforced on every read and write.** Handing a meeting chat a
workspace `conversationId` is a `404`, not a silent reparent: it would answer
from one meeting and file the turn in the workspace log, where it reads back
afterwards as a cross-meeting answer.

**Titles are derived locally, not generated** — `common/ConversationTitle`
strips a leading interrogative off the first question ("What are the action
items from last week?" → "Action items from last week"). A model call would
read slightly better and would land on the first message of every new
conversation, which is the worst place in the product to add latency and a
failure mode: the user is waiting on an answer, not on a label for a list they
are not looking at. The strip is deliberately timid — bare "who" is never
removed, and an opener whose removal would expose a preposition is kept, since
"Of these is blocking" is not a shorter title but a broken one. Renaming covers
whatever it gets wrong; a title is set once and never rewritten by a later
question.

**Deleting a message deletes the exchange.** Half of one is worse than none: a
question whose answer is gone reads as a request the app ignored, and an answer
with no question is a claim about nothing. Safe because turns are independent —
neither ask path sends prior messages to the model, so removing a pair cannot
change how a later question is answered. *If conversational memory is ever
added, this becomes a decision about rewriting history and must be revisited.*
Emptying a thread deletes the thread, so the picker never lists a row that
opens onto nothing.

The V28 backfill gives every pre-existing thread one conversation named after
its first question, so nothing already stored becomes unreachable.

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

### Transcript moments (`transcript_moments`)

Highlights, bookmarks and private notes a user marked while reading. All three
kinds are one table and one endpoint: they differ by which fields are filled in,
not by shape, lifecycle or permissions, and they are drawn over one transcript in
one pass — three requests could paint a page whose highlights and notes came from
different moments.

| Method | Endpoint | Body | Response |
|---|---|---|---|
| GET | `/api/v1/meetings/{id}/moments` | — | `MomentResponse[]`, in transcript order |
| POST | `/api/v1/meetings/{id}/moments` | `{ kind, ranges[], quote, body, speaker, startSeconds, endSeconds }` | `201 MomentResponse` |
| PATCH | `/api/v1/moments/{id}` | `{ body }` | `MomentResponse` |
| DELETE | `/api/v1/moments/{id}` | — | `204` |

`kind` is `HIGHLIGHT` \| `BOOKMARK` \| `NOTE`. A highlight needs a non-empty
`quote`; a note needs a non-empty `body`; a bookmark needs neither, because it
marks a time rather than a passage. `PATCH` edits the body only — re-pointing a
note at a different passage is a new note, and doing it in place would leave a
comment attached to words nobody wrote it about.

**The anchor is stored three ways, and this is the point of the design.**
Recallix lets people correct transcript lines. Fixing a typo near the start of a
line shifts every character offset after it, so an annotation pinned to offsets
alone does not break loudly — it slides silently onto different words.

```jsonc
"ranges": [
  { "segmentId": "seg_…", "startOffset": 10, "endOffset": 14, "quote": "ship" }
]
```

| Anchor | Survives | Used when |
|---|---|---|
| `segmentId` + offsets | nothing changed | first — and only if the text there is still the quoted text |
| `quote` | an edit elsewhere in the same line | second — nearest occurrence to the old offset wins |
| `startSeconds` on the row | a reprocess that rebuilt every segment | the list, always |

A mark that resolves by none of them is **orphaned**: it stops rendering inline
and is shown in the list labelled *line edited*, with its quote and timestamp.
Hiding it would be indistinguishable from the app losing the annotation.

`ranges` is a JSONB array rather than a child table, for the same reason as
`transcript_segments.words_json` — a selection crossing an utterance boundary
covers two or three segments, and those ranges are only ever read as a whole
moment's worth. There is deliberately **no foreign key on `segmentId`**: a
cascading delete would destroy every highlight the moment someone asked for a
better transcription.

Resolution happens **client-side at render** (`frontend/lib/moments.ts`), not on
read. The browser already has both the transcript and the moments, persisting
repaired offsets would make a `GET` a write, and reverting an edit brings the
original offsets back into agreement on its own.

**What is not here.** No threads, no `@mentions`, no reactions. Those are one
person addressing another, and Recallix has one account per workspace — there is
no second user to reply to, mention or react at. A note here is a private
annotation.

### Action items
| Method | Endpoint | Body | Response |
|---|---|---|---|
| GET | `/api/v1/action-items` | `?page&size&status&priority&owner&due&meetingId&mine` | `Page<ActionItemResponse>` |
| GET | `/api/v1/action-items/overview` | — | `ActionItemOverview` |
| GET | `/api/v1/meetings/{id}/action-items` | — | `ActionItemResponse[]` |
| POST | `/api/v1/meetings/{id}/action-items` | `{ title, ownerName?, dueDate?, priority?, sourceSentence?, sourceStartSeconds? }` | `201 ActionItemResponse` |
| PATCH | `/api/v1/action-items/{id}` | `{ title?, ownerName?, dueDate?, priority?, status? }` | `ActionItemResponse` |
| PATCH | `/api/v1/action-items` | `{ ids: [], status }` | `{ "changed": n }` |
| DELETE | `/api/v1/action-items/{id}` | — | `204` |
| GET | `/api/v1/action-items/{id}/comments` | — | `ActionItemCommentResponse[]` |
| POST | `/api/v1/action-items/{id}/comments` | `{ body }` | `201 ActionItemCommentResponse` |
| DELETE | `/api/v1/action-items/{id}/comments/{commentId}` | — | `204` |

`POST` exists for the transcript's selection menu: until it did, the one thing a
reader is most likely to notice — a commitment the extraction pass missed — was
the one thing they could not record. Hand-added items go in the same table as
extracted ones, with `sourceSentence` carrying the transcript line as evidence,
because "what did we promise" split across two lists by how each row was noticed
is two answers. It is also how the tracker adds an item by hand, which is why
`meetingId` is in the path and not optional: an item with no meeting behind it
has no source sentence, no recording to seek to and nothing for the chat to read.

**A deadline is two fields.** `dueDate` is free text and always has been — the
extractor is told to record the timing "in the words used", so it holds
"Tuesday", "end of day", "before the demo". `dueOn` is that read as a calendar
date by `common/DueDates`, resolved **once at write time against the meeting's
own date** (so "Tuesday" said on the 12th is the 14th, and the same word in next
week's meeting is a different day). It is null whenever the phrasing had no
single reading, and the parser refuses far more than it accepts — including every
bare numeric form like `03/04`, where a reader in Boston and one in London
disagree about the month. A due date we invented produces a red badge on a task
nobody is late with and an email about it at seven in the morning.

`dueStatus` (`OVERDUE｜TODAY｜SOON｜LATER｜NONE`) and `daysUntilDue` are computed
server-side against UTC today. That is deliberate: the list, the badge, the
filter tabs and the reminder digest all need to agree on what "overdue" means,
and one of those runs on a scheduler rather than in the browser. A completed item
is always `NONE` — a red badge on something already ticked off is noise that
teaches people to ignore red badges.

**Reprocessing no longer destroys tracked work.** `edited` marks a row a person
has touched — ticked off, retitled, reassigned, commented on, or added by hand —
and the sweep in `CallbackService.replaceActionItems` now spares those, as V24
already did for insights. The titles of the survivors are skipped on the way back
in, so an item somebody completed is not re-extracted as a fresh OPEN duplicate
of itself on every reprocess.

**`sourceStartSeconds` is where the sentence was said**, matched back to a
transcript segment by `common/SentenceLocator` when the brief is persisted, and
taken straight from the selection for items added by hand. Null when the sentence
could not be placed with confidence — short, common lines are never matched at
all, because a link that seeks to the wrong moment plays somebody saying
something else and reads as the evidence being fabricated.

**Comments are a private working log, not a discussion.** There is one account
per workspace, so there is nobody to reply to; the UI calls them notes. They
exist because a status of OPEN cannot say "waiting on legal until Thursday", and
they are rows rather than one growing text field because each entry keeps its own
time. Writing one marks the parent item `edited` — the log cascades away with the
item, so a note has to be enough to protect the item it is written on.

**`?mine=true` is matched against `displayName` from preferences.** Nothing joins
an account to a transcript — the account has an email, the transcript has "Priya"
— so it has to be asked once. Until it is answered the endpoint returns an **empty
page** rather than falling back to everything: a list of the whole workspace under
the heading "My tasks" reads as an answer and is not one. `ActionItemOverview`
carries the tab counts, the owner names actually assigned work (with counts, so
the filter is a pick rather than a spelling test) and `me`, which is what lets the
page offer that pick.

**Task reminders** (`taskReminders` in preferences, off by default) send one
digest a morning — 08:00 UTC, `TaskReminderJob` — listing what is overdue, due
today, and due within `DueStatus.SOON_DAYS`. Nothing is sent on a day when
nothing is due, and `users.task_reminder_sent_on` is stamped only on a successful
send, so a redeploy at the wrong minute cannot mail the same digest twice and an
SMTP outage costs a day rather than being silently swallowed.

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
| POST | `/ai/translate-lines` | `{ "lines":[],"targetLanguage" }` | `{ "lines":[] }` — **same length, same order** |
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
- Client also subscribes to `/topic/users/{channel}/notifications`, where `channel`
  comes from `GET /api/v1/notifications/unread-count` (the browser is
  authenticated as a Clerk subject and has never been told its internal user id).

**The notification frame carries `{ unread }` and nothing else, deliberately.**
The STOMP endpoint is unauthenticated — a subscription is just a topic name — so
anything published there is readable by anyone who can guess it. Meeting status
survives that: a status and a percentage say almost nothing. A notification
cannot, because its entire value is the meeting's title and the task's wording.
So the frame is a nudge, the browser re-reads over the authenticated REST API,
and a stranger guessing a user id learns that something happened and nothing
about what. The client also polls the count every 90 seconds, which is what makes
the socket an optimisation rather than a dependency.

---

## 8. Phase 2 (Agent + MCP) — scaffolded, not wired to live providers

Endpoints exist and return draft plans; external execution is stubbed with an
approval workflow. See `docs/phase2-agent-mcp.md`.
