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

No infrastructure runs locally. Postgres, Kafka and object storage are Neon,
Confluent Cloud and Cloudflare R2, reached over the internet and configured
from `.env`. Only the three application containers above are
built and run here.

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
| PATCH | `/api/v1/preferences` | `{ "autoEmailRecap"?, "recapEmail"?, "displayName"?, "department"?, "jobRole"?, "defaultLanguage"?, "shareInclude*"?, "shareExpiryDays"?, "shareNeverExpires"?, "chatHistoryDays"?, "chatReadsEverything"?, "taskReminders"?, "mutedNotifications"? }` | `PreferencesResponse` |
| GET  | `/api/v1/meetings` | `?page&size&search&tag&status&from&to&unfiled` | `Page<MeetingResponse>` |
| GET  | `/api/v1/meetings/{id}` | — | `MeetingResponse` |
| PATCH | `/api/v1/meetings/{id}` | `{ "title"?, "tags"? }` | `MeetingResponse` |
| GET  | `/api/v1/meetings/{id}/transcript` | — | `TranscriptResponse` |
| GET  | `/api/v1/meetings/{id}/summary` | — | `SummaryResponse` |
| GET  | `/api/v1/meetings/{id}/action-items` | — | `ActionItemResponse[]` |
| PATCH | `/api/v1/meetings/{id}/speakers` | `{ "mapping": { "Speaker 1": "Ana" } }` | `TranscriptResponse` |
| POST | `/api/v1/meetings/{id}/speakers/rematch` | *(no body)* | `SpeakerRematchResponse` |
| GET | `/api/v1/speakers` | — | `{ "learningEnabled", "profiles": [...] }` |
| PUT | `/api/v1/speakers/learning` | `{ "enabled" }` | `SpeakerSettingsResponse` |
| DELETE | `/api/v1/speakers/profiles/{id}` | — | `204` |
| POST | `/api/v1/meetings/{id}/reprocess` | — | `202 { "meetingId","status" }` |
| DELETE | `/api/v1/meetings/{id}` | — | `204` |

**The account profile (V38).** `department` and `jobRole` are descriptive and
read by nothing — Recallix has no teams for a department to route to. They exist
because the account page asks for them and because they go into the account
export: what somebody typed about themselves is data Recallix holds of theirs.
`email` is returned and not writable; it is the sign-in provider's fact, and a
development session has no provider and therefore no address at all. The
editable one is `recapEmail`, which is where mail should go rather than who you
are.

**`defaultLanguage` is the one that changes a transcript.** Blank/null means
auto-detect, which stays the default because it is right for a multilingual
user, and wrong for exactly the recordings people complain about: a short voice
note, a noisy first minute, a standup held half in each of two languages. A
mis-detection is not a cosmetic label — the words come back in a language nobody
spoke, the summary is written in it, and nothing downstream repairs that. The
code is validated against `Language` (the eighteen transcription supports) and
refused with a 400 rather than dropped, because a silently ignored setting leaves
the page showing a choice the pipeline never received. It is resolved at enqueue
and travels on `meeting.uploaded` as `language`, because the worker runs as a
system context with no user to read it in. A `vocabulary` list travelled beside
it for the same reason until V51 removed the feature.
The account setting wins over the deployment-wide `ASSEMBLYAI_LANGUAGE`.

**Chat defaults (V39).** `chatHistoryDays` is how far back the workspace chat
reads. V39 also added five share-link defaults beside it; those went with
sharing in V50, along with the `ck_users_share_expiry_days` constraint.

`chatHistoryDays` bounds how far back the **workspace** chat retrieves
transcripts. It travels as `historyDays` on `POST /ai/workspace-chat` and becomes
one extra `m.created_at >= floor` in `RagService._retrieve` — kept separate from
the question's own date window so "what happened last March" still says it found
nothing from March rather than quietly answering from whatever the floor left
visible. It does **not** apply when `meetingIds` is given (Add context and folder
chat both name their meetings), and it does not bound the commitment ledger: a
task owed since March is still owed, and dropping it would make the answer wrong
rather than narrower. A scope control, not a privacy boundary — nothing is
hidden, and the meeting's own chat still answers about it.

Both pairs express "none" with a companion flag (`shareNeverExpires`,
`chatReadsEverything`) for the reason in `ShareCreateRequest`: over JSON an
omitted number and an explicit null are the same thing, and one means "leave it"
while the other means "clear it".

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

### Three operations on a speaker, and one on the whole meeting

They are easy to confuse and they answer different questions. There used to be
a third — `PATCH /speakers/rematch`, which merged one label into another or
moved selected turns. It is gone, and `POST /speakers/rematch` now means the
automatic operation, which is what every other product means by the word.

**Rename** — `PATCH /speakers`. "Who is Speaker 2?" Send
`{"mapping": {"Speaker 2": "Sarah"}}`. The mapping is keyed by display name
because that is all a client can see, but it is **applied by canonical key**:
the labels are resolved to `speaker_key`s first, and every turn by that speaker
is renamed even if the label on it had drifted. Segments written before V46 have
no key and fall back to matching the name.

For an account with voice recognition on, this is also the moment a voice is
learned — see below.

**Correct one turn** — `PATCH /segments/{segmentId}/speaker`. "These words were
not that person." Send `{"speakerKey": "spk_1"}` to move a whole turn, or add
`fromWord`/`toWord` (zero-based, inclusive) to move only part of one.

The word range is the reason this exists. Automatic diarization is not perfect
and the failing case is specific: a provider that buries a short reply inside
somebody else's turn. "Yes, sir." arriving as words 5–6 of a ten-word utterance
cannot be fixed by a rename, because the other eight words are attributed
correctly. Given a range, the server splits the segment into up to three rows,
timed from the words themselves — the only points in the utterance that
correspond to anything in the audio. A segment with no per-word timings is
refused rather than cut at a character offset.

It changes **only** what was named. No neighbouring turn is merged, re-split or
relabelled, no other turn by the same speaker is touched, and no voice is
learned — enrolling a voiceprint from a turn somebody just told you was
misattributed would train the profile on the mistake. Everything derived does
move: the flat transcript the export reads, the retrieval index chat cites, and
the talk-time stats (derived on read, so they follow for free). The summary is
marked stale rather than regenerated.

`speakerKey`, not a display name: names are not unique — two people can both be
called Chris — and the key is what survives a rename. The destination must
already exist in the meeting; this endpoint cannot create a participant.

Returns the whole `TranscriptResponse`, because a partial move turns one segment
into three and a client cannot patch its cache without reimplementing the
split.

**Rematch** — `POST /speakers/rematch`, no body. "Which of these unresolved
speakers are people we already know?" Every speaker still wearing a generated
label is compared **acoustically** against the voice profiles this account has
built. Returns a count, not a transcript:

```json
{ "matched": 2, "names": ["Sarah", "Tom"], "considered": 4, "unavailable": null }
```

`matched` counts **speakers**, not turns. `unavailable` is set only when the
operation could not run at all — voice recognition switched off, not configured
on this server — and is deliberately distinct from `matched: 0`, which means it
ran and nobody cleared the confidence bar. That is an ordinary outcome. There is
**no confidence score in the response**: the matcher thresholds on cosine
similarity between embeddings, which is not a calibrated probability, and
rendering it as a percentage would invent a precision it does not have.

Never touches a speaker somebody has already named, never touches an
unattributed turn, and never uses the speaker number, the provider's cluster
letters or anything in the transcript text. See
[speaker-identification.md](./speaker-identification.md).

**Reprocess** — `POST /meetings/{id}/reprocess`, no body, `202`. "The
transcriber got the boundaries wrong." The answer to a diarization that came out
badly is now to run the clustering again rather than to ask a reader to repair
it turn by turn. It replaces the transcript, the segments, the summary and the
retrieval index from the audio.

**It is destructive and the client must say so before calling it.** Hand-typed
corrections are gone. Speaker names are gone from *this meeting* but not from
the account, so a rematch afterwards can put them back — which is the difference
between this and the "Transcribe again" that was removed for being a
one-confirm-deep way to lose an afternoon's corrections.

It also drops the meeting's cached voiceprints, and that is correctness rather
than housekeeping: they are filed under meeting-local speaker keys, the
reprocess re-derives those keys by first appearance, and a stale entry would
hand the previous occupant's voice to whoever inherits the key.

Both speaker operations re-index the meeting and rebuild the flat transcript,
because each carries the speaker prefix and chat and the export read them.

### Voice profiles (V53)

`/api/v1/speakers` is the consent control and the list of what is held under it.
**Not** part of `PATCH /preferences`, deliberately: switching learning off
*deletes every voice template the account holds*, and that must not be reachable
from a null-means-unchanged bulk patch that the settings page sends whenever
anything on it moves.

A profile carries `id`, `name`, `samples`, `createdAt`, `updatedAt`. It does not
carry the embedding, and neither does the JPA entity — the column is not mapped,
so there is no code path in Spring that could put a voice template into a
response. See [speaker-identification.md](./speaker-identification.md) for the
privacy boundary, and `V53__speaker_profiles.sql` for the five rules.

### Custom vocabulary & known speakers

**Removed (V51).** Six endpoints under `/api/v1/vocabulary` and
`/api/v1/speakers`, two tables, and everything downstream of them.

Custom vocabulary was a per-user list of terms — names, jargon, acronyms —
resolved by Spring at enqueue and sent to the transcriber as boosting hints,
expressed differently by each provider (`keyterm` on Deepgram nova-3+,
`keywords` before it, `keyterms_prompt`/`word_boost` on AssemblyAI, and
Whisper's decoding `prompt`, which has no boosting parameter of its own).
Known speakers was a per-user list of names, written by renaming or rematching
a speaker rather than by a create endpoint, which filled the rename box and
travelled on the event as `context.participants`.

**Both tables were dropped rather than left standing.** Nothing wrote to them
once renaming stopped recording names, and nothing could read them once the
endpoints went. Rows left behind would be personal data — colleagues' names, in
the second case — held by a product with no feature that justifies holding them
and no screen that could show anybody what was in them.

**What this takes with it.** `MeetingUploadedEvent.vocabulary` and
`MeetingContext.participants` are gone from the event contract; the ai-service
declares neither, so a backlog published before the change still validates and
processes. The `vocabulary` argument on `TranscriptionPort.transcribe` went with
them rather than being threaded through four adapters as a permanent `None`.
`build_keyterms` survives with one remaining source, `organisations`, which the
enqueue path sends empty — so no boosting field reaches any provider, which is
exactly what happened for every account that never added a term. The prose
`prompt` channel is unaffected and still carries the meeting's title, project
and type.

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

**Removed (V50).** A share link was a token in `meeting_shares` that made one
meeting readable at `/public/shared/{token}`, optionally password-protected,
optionally expiring, with four flags choosing how much it revealed. All of it is
gone: seven endpoints, the public page, the four account-level defaults, the
`SHARE_VIEWED` notification and the "conversation shared" email.

**The table was dropped rather than orphaned**, for the same reason as the
calendar token in V48: the token *was* the access check, and a route that no
longer exists revokes nothing. Rows left behind would be unreachable but not
withdrawn, and any future read path over them would silently republish every
meeting anybody ever shared. Deleting them is the revocation, and it is
irreversible on purpose — restoring the table would not restore the links,
because what somebody holds is a URL and the only thing that made it work was
the row.

**What this takes with it.** `GET /privacy/links` and
`POST /privacy/links/revoke-all` are gone, and `PrivacyOverviewResponse` no
longer carries `liveLinks`: "who else can see it" was a question about share
links, and the answer is now nobody. `ErasureService` no longer narrows a live
link when audio or a transcript is erased — there is no link to narrow.

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

**Eleven kinds, emitted from events that already existed.** `RECORDING_STARTED`,
`PROCESSING_STARTED`, `TRANSCRIPT_READY`, `SUMMARY_READY`, `PROCESSING_FAILED`,
`RECAP_SENT`, `ACTION_ITEM_DUE`, `ACTION_ITEM_OVERDUE`, `MENTIONED_IN_MEETING`,
`SHARE_VIEWED`, and — added by V35 — `RETENTION_APPLIED`. Before this, all of it
happened in the log: the only feedback
surface was the live status socket on one meeting page, so closing the tab meant
the product had nothing to say about the twenty minutes it spent working.

**Inbox and Unread are two queries against `?unread=`, not one list filtered
twice.** The panel holds twenty rows; somebody with sixty notifications and four
unread would otherwise open Unread and see whichever of the four fell inside the
most recent twenty. Filtering happens in the database, so the tab means what it
says however long the archive is.

**Nothing trims this table.** There is no retention job over `notifications` —
rows live until the owner clears them or the account is deleted (`ON DELETE
CASCADE`). The panel therefore reports what it is showing ("Showing the 20 most
recent of 64") rather than claiming a rolling window the product does not
enforce.

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
still running. It is one of two kinds that cannot be muted — `mutable: false` —
because switching it off makes "nothing happened" and "something broke" the same
silence. V35 adds the other, `RETENTION_APPLIED`, for the same reason with the
stakes reversed: "nothing happened" and "something is gone for good".

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

### Home and action items (V36)

| Method | Endpoint | Body / Query | Response |
|---|---|---|---|
| POST | `/api/v1/action-items` | `{ title, ownerName?, dueDate? }` | `ActionItemResponse` |
| GET | `/api/v1/chat/modes` | — | `ChatModeResponse[]` |
| POST | `/api/v1/chat` | `{ question, meetingIds?, conversationId?, mode? }` | `ChatMessageResponse` |

**An action item no longer needs a meeting.** Every one used to be a fact
extracted from a transcript, which is why it hung off `meeting_id` and inherited
its tenancy from the meeting. The home panel breaks that: "Write the migration"
is typed into a box and belongs to the person, not to a conversation. Attaching
it to the most recent meeting — the obvious dodge — would file it in a call it
was never mentioned in and delete it the day that call is deleted. So
`meeting_action_items` gained `user_id` (backfilled, NOT NULL), `meeting_id`
became nullable, and the RLS policy changed from the meeting-owned `EXISTS` to a
direct `user_id = app_current_user()` — the old predicate is false for exactly
the rows somebody has just typed, so their own work would have been invisible to
them. `MeetingActionItemRepository.OWNED_BY` and `dueByUser` changed with it;
grouping the deadline pass through `Meeting` would have silently dropped every
hand-typed task, which is the half most likely to carry a date.

**Quick and Thorough are a real difference, not a label.** `ChatMode` travels
to the ai-service as `mode`, and the two settings differ in exactly two things so
neither is a worse version of the other: retrieval width
(`rag_workspace_top_k` = 10 vs `rag_workspace_deep_top_k` = 25) and whether the
answer is asked to enumerate rather than summarise. The commitment and decision
ledgers are in **both** — they are the complete record rather than a retrieved
sample, and withholding them from the cheaper mode would make it confidently
wrong about what is outstanding rather than merely shallower. Absent means
Quick, which is precisely what every caller got before the field existed.

They were called Express and Advanced, which named two different axes — speed
against capability — and so read as though the fast one was the stupid one.
**The wire values are still `express` and `advanced`**: `rag.py`,
`answering.py` and `retrieval.py` all speak them, the two services deploy
separately, and renaming a protocol to match a label is churn with a window of
outage in it. `ChatMode.of` accepts both spellings so a tab open across the
rename still resolves.

**"Add context" is a narrowing, not an attachment.** The picker's chosen
meetings arrive as `meetingIds` on the same endpoint — one question, narrowed.
Folders are resolved to their meetings when the question is asked rather than
when the chip is added, so a folder that gains a meeting tomorrow is still the
right answer; the picker takes one folder at a time because React forbids a hook
per selection, and the limit is enforced in the control rather than ignored
later.

**There are no integrations, and the removal is V48.** V36 added an outbound
ICS feed of action item deadlines: `users.calendar_token`, 192 bits from
`SecureRandom`, served at `/public/calendar/{token}.ics` under the tenant
exemption. It was the one integration Recallix had, and it is gone — the
controller, the service and the column. The column matters most: the URL **was**
the credential, because Google's servers fetch it with no session and no header
we could add, so a token left in the table after the route stopped existing would
be a live secret nothing could honour. Dropping it is the revocation. V8 and V17
added the inbound direction — *reading* somebody's calendar over OAuth — and
V18 removed that; this is the same round trip in the other direction.

**Settings is one page with five tabs.** `/settings/<tab>` —
General, Meetings, Plans, Emails, Security — replacing four routes in three
places (Settings, Billing and Privacy were all sidebar items). Integrations was a
sixth tab until its only content, the feed above, was removed. The tab is in the
URL rather than in state so it can be linked, and `/privacy` and `/billing` still
render their tab under their old paths rather than redirecting: `RETENTION_APPLIED`
notification rows carry `/privacy` in their link column, and those rows are a
record of something that happened. Only the open tab mounts — Security counts
every row a workspace owns, and that should not be paid for by somebody changing
their recap address. An unrecognised path falls back to General, which is also
what `/settings/integrations` now gets, because a blank pane under a tab bar
reads as a page that failed to load rather than a URL that was mistyped. Mapping
lives in `lib/settings-tabs.ts`.

**Frontend shape.** `/home` replaces the dashboard: conversations grouped by day
on the left, and a two-tab rail on the right holding the same chat thread as
`/ask` (see `useWorkspaceChat`) and the workspace action items. Search moved out
of a filter bar into one box with a small grammar — `from:`, `in:`, `tag:`,
`type:`, `status:`, `owner:`, `when:`, `decided:` — parsed by
`lib/search-query.ts`, which resolves values against the workspace's own facets
and **drops** anything that matches nothing rather than sending a filter that
returns an empty page looking like a broken search. A prefix matching two
speakers resolves to neither, because picking the first would answer a question
about Priya with Priyanka's lines and nothing on screen would reveal it.

### Privacy & data (V35)

| Method | Endpoint | Body / Query | Response |
|---|---|---|---|
| GET | `/api/v1/privacy` | — | `PrivacyOverviewResponse` |
| GET | `/api/v1/privacy/links` | — | `LiveLinkResponse[]` |
| POST | `/api/v1/privacy/links/revoke-all` | — | `{ revoked }` |
| PATCH | `/api/v1/privacy/retention` | `{ audioDays?, meetingDays? }` | `Retention` |
| DELETE | `/api/v1/privacy/account` | `{ confirm }` | `{ meetings, storedObjects }` |
| DELETE | `/api/v1/meetings/{id}/audio` | — | `{ audioDeletedAt }` |
| DELETE | `/api/v1/meetings/{id}/transcript` | — | `{ transcriptDeletedAt }` |

**Recallix had the architecture and none of the controls.** Row-level security
means one account cannot read another's rows; the audio is in a private bucket
reachable only through a URL we sign for fifteen minutes;
per meeting, and revocable. All true, all invisible, and the settings page's
"Danger zone" popped a toast saying deletion was not implemented. A privacy claim
nobody can check from inside the product is marketing.

**There is no bulk export.** `GET /privacy/export` built the whole account as a
zip — every meeting in JSON another system could read, plus readable copies —
and it is gone, along with `AccountExportService`. It was the largest response
the API could produce and the only one that read every row a workspace owns in a
single request. A meeting still exports in four formats from
`GET /meetings/{id}/export`; nothing exports all of them at once, so leaving is
now `DELETE /privacy/account` with no download in front of it.

**Erasure has grains, because "delete the meeting" is the wrong unit.** The
recording is the sensitive artefact — somebody's voice, the largest object, the
one thing that can be replayed out of context — and the notes drawn from it are
usually what the meeting was for. So `DELETE .../audio` removes the object and
keeps everything derived; `DELETE .../transcript` removes the segments, the marks
made on them, every translation **and the pgvector embeddings**, keeping the
summary and action items; `DELETE .../{id}` is unchanged. `meetings.audio_deleted_at`
and `transcript_deleted_at` are timestamps rather than flags, because the question
asked afterwards is always "when", and because a null `object_key` is also true of
a YouTube import and of an upload in flight.

**The embeddings are on the transcript's side of the line.** `transcript_chunks`
is written and read entirely by the ai-service, and a transcript deleted while its
vectors survive is worse than one never deleted: chat would keep answering out of
text the account holder was told had gone, citing a source no page can show them.
Whole-meeting deletion gets this by foreign key; transcript-only deletion goes
through `TranscriptChunkRepository`.

**Erasure narrows live links rather than revoking them.** A link promising audio
that has been deleted would hand its reader a signed URL for an absent object. It
is narrowed, not withdrawn — whoever holds it was given the notes too, and taking
those back is a different decision from erasing a recording.

**Retention is two dials, both null by default.** `users.audio_retention_days`
and `meeting_retention_days`. "How long do you keep the recording of my voice" is
asked by the people in the meeting; "how long do you keep the notes" is asked by
the account holder, and thirty days and forever is a coherent answer to that pair
that one dial cannot express. A meeting window shorter than the audio window is
**refused**: nothing breaks, but the narrower promise never runs, and a policy
that silently does not do its job is worse than one that will not save. Age is
measured from `created_at`, not last access — last-touched retention means the
recording of a sensitive conversation survives precisely because people keep going
back to it. `RetentionJob` runs at 03:00 UTC (`recallix.retention.cron`,
`recallix.retention.enabled`) and shares `ErasureService` with the buttons, so the
nightly pass and the menu item cannot come to disagree about what deleted means.

**The interface offers three windows; the API still accepts 1..3650.** Never, a
week and a month — `RETENTION_CHOICES` in `frontend/lib/privacy.ts`. The list was
six until 90 days, six months and a year were dropped: all three are long enough
that the decision they encode is "eventually", which is not a promise anybody can
hold you to. A policy already set to one of them keeps working and is *named*
rather than drawn as one of the three, because three unpressed buttons read as
"nothing is deleted". Both dials are sent on every change — null means keep
forever, not "leave this one alone" — and the pair the server refuses is disabled
in the UI rather than offered and rejected.

**These controls had no interface for months.** Retention could only be set, and
an account only closed, by calling the API by hand: the tab that held them was
removed and the endpoints were not. A deletion schedule that fires unattended
every night and cannot be seen from inside the product is the worst version of
this feature, and both now live on Account Settings → General.

**`RETENTION_APPLIED` joins `PROCESSING_FAILED` as unmutable.** They are the two
whose silence is indistinguishable from nothing having happened — one is "something
broke", the other is "something is gone for good" — and the retention one is the
more dangerous, because the rule behind it was set once and then fires unattended
for years. One notification for the whole night's work, deduped by day; a policy
switched on over an old archive erases hundreds of things on its first run.

**Encryption at rest is reported, never claimed.** `StorageFacts.encryptionAtRest`
comes from `GetBucketEncryption` on the live bucket and is **null** when it applies
none, which is what a default docker-compose MinIO will say. The setting belongs to
the bucket and the bucket belongs to whoever runs the deployment, so an application
printing its own intent has told the reader nothing. `s3.default-encryption`
(`AES256` / `aws:kms`, plus `s3.kms-key-id`) applies it at startup when set —
applied to the bucket rather than per upload, because uploads are presigned PUTs
performed by a browser and an encryption header signed into one must be echoed
byte-identically or the signature fails.

**The account export is removed.** `GET /privacy/export` returned the whole
account as a zip — `account.json`, `meetings.json`, `action-items.csv` and a
rendered `notes.md` per meeting — deliberately without the audio, which would
have been gigabytes through a request thread. It is gone from the server, so
unlike retention and account closure there is no API call to fall back on: a
meeting still exports in four formats from its own page, and nothing exports all
of them at once. The one
field mapped by hand rather than serialised is `meeting_shares.password_hash`: a
credential is worth nothing to the person downloading their own data and something
to whoever later finds the zip.

**Closing an account is immediate and irreversible.** No soft delete, no thirty-day
bin. The alternative means answering "yes, that is deleted" while the data is still
on disk and restorable by whoever runs the servers, which is the answer this page
exists to make true. Guarded by typing `delete everything` — checked in the service,
not the controller, and again in the browser only so the button can be disabled.
Implementation is two steps: delete every stored object, then delete the one `users`
row. Every user-owned table declares `user_id ... REFERENCES users(id) ON DELETE
CASCADE`, so Postgres does the rest — a hand-written list of thirty tables is a list
that stops being complete the first time somebody adds a table.

**Consent is recorded, not verified.** `meetings.consent_confirmed_at` is set when
the browser recorder sends `consentConfirmed`. Until now the tick on the record page
enabled a button and was then forgotten, which makes it theatre; stamped on the
meeting it becomes a record that the person asked. Only the recorder sends it — an
uploaded file was captured somewhere Recallix was not present to ask — and the page
also hands over the sentence to say out loud, because **Recallix has no bot**. It
never joins a call and never appears in a participant list, so "the bot is visibly
identified as Recallix" has no counterpart here; the announcement has to come from
the person recording, and giving them the words is the difference between a policy
and a thing that gets said.

### Projects (V30)

| Method | Endpoint | Body | Response |
|---|---|---|---|
| GET | `/api/v1/projects` | — | `ProjectResponse[]` (with `meetingCount`) |
| GET | `/api/v1/projects/unfiled` | — | `MeetingResponse[]` |
| GET | `/api/v1/projects/{id}` | — | `ProjectResponse` |
| GET | `/api/v1/projects/{id}/meetings` | — | `MeetingResponse[]` |
| POST | `/api/v1/projects` | `{ "name", "description"?, "color"? }` | `201 ProjectResponse` |
| PATCH | `/api/v1/projects/{id}` | same + `"favorite"?`, all optional | `ProjectResponse` |
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

**Starred folders, and a `updated_at` that means it (V37).** `projects.favorite`
is one boolean and one sort key — `list` returns starred first, then
alphabetical, and the sidebar and the folder page read the same order so nobody
has to check they are looking at the same list. It is deliberately not a second
grouping: a starred folder is the same folder, listed first. On the request it is
boxed (`Boolean`), because an omitted field has to be distinguishable from
`false` or every rename silently unstars.

The same migration fixed what `updated_at` meant. It was the row's own last
write, which made the folder list's "Last Updated" column quietly wrong — filing
three meetings into a folder left it reading as untouched since the day it was
named. `assign` now stamps both the folder a meeting leaves and the one it
joins, and V37 backfills existing rows from the newest meeting each holds.

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
| people | `transcript_segments.speaker` ∪ `meeting_action_items.owner_name` |
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
| GET | `/api/v1/action-items` | `?page&size&status&owner&due&meetingId&mine` | `Page<ActionItemResponse>` |
| GET | `/api/v1/action-items/overview` | — | `ActionItemOverview` |
| GET | `/api/v1/meetings/{id}/action-items` | — | `ActionItemResponse[]` |
| POST | `/api/v1/meetings/{id}/action-items` | `{ title, ownerName?, dueDate?, sourceSentence?, sourceStartSeconds? }` | `201 ActionItemResponse` |
| PATCH | `/api/v1/action-items/{id}` | `{ title?, ownerName?, dueDate?, status? }` | `ActionItemResponse` |
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

**Task reminders** were a digest mailed at 08:00 UTC listing what was overdue,
due today, and due within `DueStatus.SOON_DAYS`. Removed in V56 with the rest of
the mail, along with the `ACTION_ITEM_DUE` and `ACTION_ITEM_OVERDUE` bell
notifications the same job raised. Deadlines are read from the tab counts and
`DueStatus` above; nothing pushes them at anybody.

### Usage
| Method | Endpoint | Body | Response |
|---|---|---|---|
| GET  | `/api/v1/usage` | — | `UsageResponse` |

**Billing is gone, and so is the way past the allowance (V48/V49).** Stripe
checkout and its public webhook were removed: every account gets the same 100
minutes and 3 imports for its lifetime, so there was nothing for a payment to
buy. `users.plan` survives as a label on rows an earlier build created — no
code writes it and no limit reads it.

**The allowance is now enforced against both ways of making a meeting.** A
recording used to be exempt from the length check, because refusing one at save
time destroys audio somebody sat through; that exemption *was* the overrun. It
is gone, and what makes it safe is `frontend/lib/allowance.ts`: the browser
refuses to start a recording with no balance and stops one that reaches the
edge, so what arrives at `chargeMeetingOrThrow` always fits. The client fails
*closed* — an unreadable balance refuses to start rather than risking a
recording the server cannot accept.

**AI Chat closes with it.** All three ask paths — meeting, folder and workspace
— call `UsageLimitService.requireAiOrThrow` before the question is persisted.
Chat spends no transcription minutes, so this is a product decision rather than
an accounting one: 100 minutes is the whole of what an account gets, and an AI
feature still answering afterwards would make the limit a limit on recording
rather than on Recallix. Reads are untouched — existing conversations stay
readable.

### Internal callback (FastAPI -> Spring, `X-Internal-Token`)
| Method | Endpoint | Body | Purpose |
|---|---|---|---|
| POST | `/internal/meetings/{id}/status` | `{ "status", "progress", "message", "processingAttempt" }` | Push status; Spring persists it and relays to WS |
| POST | `/internal/meetings/{id}/result` | `MeetingBriefResult` (with `processingAttempt`) | Persist transcript/summary/actions/decisions/risks |

Both bodies carry `processingAttempt`: the run the worker is reporting, copied
from the `meeting_uploaded` event that started it and never re-read from the
meeting row. Spring compares it against `meetings.processing_attempt`:

| Callback attempt | Meaning | Response | Effect |
|---|---|---|---|
| `== current` | the run in flight | `200` | applied, and charged and deduped under that attempt |
| `< current` | overtaken by a reprocess | `200` | **nothing at all** — no writes, no charge, no notification, no WebSocket frame |
| `> current` | a run the meeting never started | `409 CONFLICT` | nothing, and logged at ERROR |
| absent | a worker older than the field | treated as attempt `1` | applied only to a meeting that has never been reprocessed |

A stale callback answers `200` on purpose. The worker holds its Kafka offset
until Spring accepts a callback, and `meeting_uploaded` has one partition — so
an obsolete message that could never be accepted would queue every later meeting
behind it. `409` is likewise a *permanent* answer, and the worker treats it as
one: it commits the message rather than retrying a request that will be refused
identically for ever.

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

### Embedded chunks belong to a processing run (V58)

`transcript_chunks` is the one piece of a meeting's derived state Spring does not
write — the worker indexes it directly, during processing, minutes before the
result callback exists. The stale-attempt check inside `applyResult` therefore
cannot protect it, and before V58 a redelivered attempt-1 execution ran a blind
`DELETE FROM transcript_chunks WHERE meeting_id = ?` and put the old transcript
back. Its result callback was then rejected as stale, correctly and far too
late: the page showed the new transcript and chat answered from the old one.

Every row now carries `processing_attempt`, and two separate things use it.

* **Writing** holds the meeting row for the length of the write, and deletes
  only `processing_attempt <= N`:

  ```sql
  BEGIN;
    SELECT processing_attempt FROM meetings WHERE id = ? FOR NO KEY UPDATE;
    -- not this run's number?  commit nothing and leave
    DELETE FROM transcript_chunks WHERE meeting_id = ? AND processing_attempt <= N;
    INSERT INTO transcript_chunks (…, processing_attempt) VALUES (…, N);
  COMMIT;
  ```

* **Reading** takes the newest generation present per meeting, via
  `NOT EXISTS (… newer.processing_attempt > c.processing_attempt)` on all three
  query paths (meeting chat, workspace chat, semantic search).

The generation scope alone was not enough, and the gap is worth naming: it stops
a delete reaching a *newer* run's rows, and does nothing when no newer run has
indexed yet — which is the whole window between pressing reprocess and the new
run finishing. In that window generation 1 is not a superseded copy of anything,
it is the transcript the user is chatting with, and a redelivered attempt-1
execution would delete it and write its own text over it, corrections and all.

`MeetingService.reprocess` advances `processing_attempt` with an ordinary
`UPDATE`, which takes the same row at `FOR NO KEY UPDATE` strength. So exactly
one of two orders happens and both are correct:

| order | outcome |
|---|---|
| index commits first | the reprocess waits for it; this run genuinely was current when it wrote |
| reprocess commits first | the index reads the new number under the lock and does nothing |

There is no interleaving in which a stale run's delete lands. `FOR NO KEY UPDATE`
rather than `FOR UPDATE` deliberately: it conflicts with the reprocess, which is
the point, without blocking the `FOR KEY SHARE` that every insert referencing the
meeting takes — a segment, an action item, a notification.

Nothing slow runs under that lock. Chunking and embedding — the network call to
the model — finish before the connection is checked out; the lock covers one
delete and the inserts.

**Erasure joins the same queue.** `ErasureService.eraseTranscript` takes the
meeting row with the same `FOR NO KEY UPDATE` before it deletes any of the rows
drawn from it. It used to take `transcript_chunks` first and the meeting last,
which is the opposite order to the indexer — reproducible as a PostgreSQL
deadlock whenever a meeting was erased while it was being indexed.

That erasure is also one transaction with no escape hatch. The chunk delete was
wrapped in a `try` that logged and continued; the embeddings are the one leftover
that can still speak, in prose, with a citation, so "erased apart from the part
that can quote it back to you" is not a deletion. If any part fails, none of it
happens and the caller is told.

Erasing a transcript **advances `processing_attempt`**. Erasure is not a run, but
it needs exactly what the number already provides: a way to invalidate
executions that are already in flight. Without it, a pipeline run that started
before the erasure would wake afterwards, find its own attempt still current,
and write the transcript back through `applyResult` and the embeddings back
through the indexer. With it, both are stale by the check each already makes, and
neither side needs to know erasure exists. The recording is untouched, so the
meeting can still be reprocessed afterwards — that run gets the next number and
indexes normally.

Object-storage deletion stays outside the transaction and keeps its existing
semantics: the object goes first, and a failure there leaves an orphaned object
rather than a row claiming audio it no longer has.

**Newest generation present, not the meeting's current attempt.** Reprocessing
does not delete the transcript, the summary or the action items while it runs,
and chat does not go dark either: the previous run stays answerable until the new
one has finished indexing. Matching on `meetings.processing_attempt` would have
blanked a meeting's chat for the length of a transcription.

`POST /ai/index` — the re-index Spring calls after a transcript edit — carries
`processingAttempt` for the same reason, read off the meeting row. An edit filed
under an older generation would be invisible, and chat would keep answering with
the wording that was just corrected.

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
  "dueDate": "Friday",
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
{ "plan": "FREE",
  "minutesUsed": 42, "minutesLimit": 100,
  "importsUsed": 2, "importsLimit": 3,
  "meetingsUsed": 9 }
```
One allowance, every account, for the life of the account: 100 transcribed
minutes and 3 imports (`UsageLimitService.MINUTES_ALLOWANCE` / `IMPORT_ALLOWANCE`).
There is no period, so no reset date — the monthly `periodStart`/`periodEnd` pair
went with it in V47. `plan` is a name only and carries no limits: FREE, PRO and
PREMIUM are allowed the same. `meetingsUsed` is a figure with no ceiling; what is
capped is minutes and imports.

---

## 6. Kafka topic (JSON value, key = meetingId)

One topic. It dispatches work; every report comes back over the internal HTTP
callbacks in §5.

**The relay is safe to run on every instance.** Each tick claims its rows with

```sql
... WHERE published = false
  AND NOT EXISTS (an earlier unpublished row for the same topic + partition_key)
ORDER BY created_at, id LIMIT 100 FOR UPDATE SKIP LOCKED
```

so two backends divide the backlog instead of both publishing all of it. The
lock *is* the claim — there is no lease column, so a rollback or a killed
instance releases its rows with nothing to expire and nobody to sweep.

The `NOT EXISTS` buys **per-key FIFO**: a meeting's events are published in
order and never concurrently, while different meetings proceed in parallel.
Global FIFO across all meetings is gone, and it had to be — it is precisely the
property a second relay cannot preserve. Nothing depends on it: every event
carries its `processingAttempt`, and an out-of-order attempt is refused by the
checks in §3 rather than applied.

`SKIP LOCKED` stops two relays owning the same row. It does **not** make
outbox → Kafka exactly-once.

**Delivery is at-least-once, in both directions.** The outbox relay republishes
a row whose `published` flag did not commit, and the worker commits its Kafka
offset only after Spring has accepted a terminal outcome — the result callback
for a success, the FAILED status callback for a failure. So one meeting can be
processed more than once, and `applyResult` can be called more than once for the
same run. It is not exactly-once and does not try to be.

What makes that safe is that the durable effects are idempotent per *processing
attempt* (`meetings.processing_attempt`, V57): the transcript, segments, summary
and insights are replaced rather than appended, AI minutes are claimed through
the primary key of `meeting_usage_charges`, and the four processing
notifications carry an attempt-scoped dedupe key. Reprocessing increments the
attempt, so it is charged and announced again — which is the intended
behaviour, since it transcribes again.

Redelivery still re-runs transcription, and the provider bills for it.

**The attempt travels with the message.** `meeting_uploaded` carries the
`processingAttempt` that was current when Spring created the job, the worker
reads it once and quotes it on every callback, and no retry, redelivery or
audio-fallback ever changes it. Only `MeetingService.reprocess` starts a new
one.

Deriving it at callback time instead — reading `meetings.processing_attempt`
when the result lands — was a race with reprocess, and a losing one. Run 1
finishes, its HTTP response is lost, the worker keeps the message; the user
reprocesses, so the meeting is on run 2 and a second job is queued; Kafka
redelivers run 1 first. Reading the row, run 1's result *became* run 2: it spent
run 2's `meeting_usage_charges` claim, took run 2's notification keys, and wrote
the old transcript over the new one — after which run 2 landed and found every
one of its own effects already claimed, so it changed nothing and said nothing.

**Consumer liveness.** `max_poll_interval_ms` is set explicitly to 6,000,000
(100 minutes, `Settings.kafka_max_poll_interval_ms`). aiokafka's default is five
minutes, measured from the last time a message was handed to the loop, and its
heartbeat task leaves the group once that is exceeded — so any meeting taking
longer than five minutes end-to-end was evicted mid-run, had its offset commit
refused, and was redelivered to be transcribed and paid for all over again. The
value covers the ~59-minute worst case that the pipeline's own timeouts allow
(3 × 900s of AssemblyAI, plus fetch, decode, three LLM passes and the callbacks)
with about 41 minutes of margin.

| Topic | Produced by | Consumed by | Payload |
|---|---|---|---|
| `meeting_uploaded` | Spring | FastAPI | `{ meetingId, userId, audioUrl, objectKey, sourceType, sourceUrl, summaryTemplate, language, context, speakers, processingAttempt }` |

There were eight. `transcription_started`, `transcription_completed`,
`summary_generated`, `action_items_extracted` and `meeting_processing_failed`
were published by FastAPI beside the HTTP callback that carried the same event,
and the only subscriber wrote a log line — the transcript, the summary and the
FAILED state were always persisted from the callback. `payment_successful` and
`usage_limit_reached` had no producer at all after Stripe was removed in V49.
All seven were deleted; nothing that reaches a user changed.

`StatusEvent`:
```jsonc
{ "meetingId": "mtg_123", "status": "TRANSCRIBING", "progress": 5,
  "message": "Generating transcript from audio..." }
```

**`progress` is one ladder shared by two codebases, and it has to stay that
way.** The browser cannot rely on these events alone — a proxy that drops the
WebSocket would leave the bar frozen over a meeting that finished minutes ago —
so it also polls the meeting's *status* and converts that to a percentage
itself. Two sources, one number. When the two disagreed (the worker opened at 10
while the browser's table read 25 for `QUEUED`) every meeting's bar visibly went
backwards the moment work began.

So each value below is the **floor** of its status. A stage may report higher as
it goes; a poll arriving afterwards answers with the floor again, which is why
the browser also refuses to let the number fall.

| Reported by | Status | `progress` | Constant |
|---|---|---|---|
| Spring, on create | `CREATED` / `UPLOADED` / `QUEUED` | 1 / 2 / 3 | `statusProgress` |
| status callback, transcription start | `TRANSCRIBING` | 5 | `PROGRESS_TRANSCRIBING` |
| status callback, transcript ready | `TRANSCRIBING` | 55 | `PROGRESS_TRANSCRIBED` |
| status callback, summarizing | `SUMMARIZING` | 60 | `PROGRESS_SUMMARIZING` |
| status callback, extracting | `EXTRACTING` | 90 | `PROGRESS_EXTRACTING` |
| final status callback | `READY` / `FAILED` | 100 | `PROGRESS_DONE` |

`FAILED` reports 100, not 0: it is where this meeting's progress ended, and an
empty bar beside a "Processing failed" card reads as a job that never started.

Definitions live in `ai-service/app/pipeline.py` and `frontend/lib/format.ts`;
`frontend/lib/progress.ts` enforces the rest, and `progress.test.ts` reads the
Python constants directly so the two halves cannot drift apart unnoticed.

---

## 7. WebSocket (Spring -> frontend)

- STOMP over SockJS at `ws://localhost:8080/ws`.
- Client subscribes to `/topic/meetings/{meetingId}`.
- Server pushes `StatusEvent` payloads.
- The polling fallback is `GET /api/v1/meetings/{id}`, which reads the status column this callback wrote
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
