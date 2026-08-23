# Recallix AI

> Turn meeting audio into accurate transcripts, concise summaries, decisions, risks, and trackable action items.

Recallix AI is a production-style, multi-service SaaS. Bring a meeting in —
import audio or video, paste a YouTube link, upload typed-up minutes, or record
one from your microphone — and it transcribes, summarizes, and extracts
decisions / action items / risks, streams live progress over WebSockets, and
tracks commitments and decision drift *across* meetings.

## Architecture

```
Next.js Frontend ──Clerk JWT──▶ Spring Boot API ──┬── PostgreSQL + pgvector
   ▲  (STOMP/WS status)                            ├── Redis (status/rate limit)
   └───────────────── WebSocket ◀──────────────────┤── S3 / MinIO (audio)
                                                    │
                                    Kafka: meeting_uploaded
                                                    ▼
                                     Python FastAPI AI Worker
                    ├── Transcription: AssemblyAI · Deepgram · Whisper · mock
                    ├── LLM: summary + extraction, run in parallel
                    ├── pgvector (chunk + embed for RAG)
                    └── callback ──▶ Spring (persist result)
```

| Service | Stack | Port |
|---|---|---|
| `frontend/` | Next.js 14, React, TypeScript, Redux Toolkit, Tailwind, shadcn/ui | 3000 |
| `backend-spring/` | Java 21, Spring Boot 3, Spring Security, Spring Kafka, JPA, Flyway | 8080 |
| `ai-service/` | Python 3.12, FastAPI, OpenAI, aiokafka | 8000 |
| infra | Postgres 16 + pgvector, Redis 7, Kafka (KRaft), MinIO (S3), Mailpit | — |

Transcription is chosen separately from the LLM, because the two are not the
same decision: AssemblyAI and Deepgram diarize, Whisper does not. `auto` follows
whatever `AI_PROVIDER` is set to.

## Quick start

```bash
cp .env.example .env         # defaults run with NO external keys (dev auth + mock AI)
docker compose up --build
```

- Frontend:  http://localhost:3000
- Spring API: http://localhost:8080/actuator/health · Swagger: http://localhost:8080/swagger-ui.html
- AI service: http://localhost:8000/health · Docs: http://localhost:8000/docs
- MinIO console: http://localhost:9001 (minioadmin / minioadmin)
- **Mailpit** (catches every email the product sends): http://localhost:8025

The stack runs end-to-end out of the box: **dev auth** (no Clerk account needed)
and **mock AI** (deterministic transcript/summary, no OpenAI key). To enable the
real pipeline set `AI_PROVIDER=openai` + `OPENAI_API_KEY`, and/or
`RECALLIX_AUTH_MODE=clerk` with Clerk env vars. See [.env.example](.env.example).

> A dev session has no identity provider and therefore **no email address**, so
> every automatic email is correctly refused rather than sent nowhere. Set a
> recap address through `PATCH /api/v1/preferences` to exercise them.

### Demoing Meeting Memory without an API key

The mock provider returns a three-meeting *narrative*, not one fixed transcript,
so the cross-meeting features have something real to find. Upload any three
audio files named `week1.*`, `week2.*`, `week3.*` — a digit in the filename picks
the week, so the story replays in order:

| Week | What happens | What memory detects |
|---|---|---|
| 1 | Three promises made; S3 + Whisper decided | 3 commitments opened |
| 2 | JWT done, Kafka consumer slipped, Whisper → Deepgram | `FULFILLED`, `SLIPPED`, `CONTRADICTS` |
| 3 | Mock-provider work cancelled, benchmark completed, S3 confirmed | `CANCELLED`, `FULFILLED`, `REAFFIRMS` |

Files without a digit are hashed to a week, so reprocessing the same audio is
stable. `DROPPED` needs a promise to go unmentioned across three later meetings,
so it takes a fourth upload to see.

## Docs

- [Architecture](docs/architecture.md)
- [API contracts](docs/api-contracts.md) — REST, Kafka, WebSocket, JSON shapes (source of truth)
- [Database schema](docs/database-schema.sql) — 53 Flyway migrations
- [Deployment](docs/deploy.md)
- [Demo script](docs/demo-script.md)
- [Speaker identification](docs/speaker-identification.md) — how a voice named in
  one meeting is recognised in another, and the biometric-adjacent data that needs
- [Speaker diarization](docs/diarization.md) — provider clusters vs. Recallix speakers
- [Load testing](docs/load-testing-report.md) — test plan; not yet run

## Feature status

### Getting a meeting in

| Feature | Status |
|---|---|
| Audio / video upload (S3 presigned) | ✅ |
| **YouTube import — paste a link, no upload** | ✅ |
| **PDF import — summarise typed-up minutes** | ✅ |
| **In-browser recording — docked bar with live text, survives navigation** | ✅ |
| Transcription (AssemblyAI · Deepgram · Whisper · mock) | ✅ |
| **Speaker diarization** (AssemblyAI / Deepgram) | ✅ |
| Speaker renaming | ✅ |
| **Per-meeting spoken language, overriding the account default** | ✅ (no UI) |

### Reading one meeting

| Feature | Status |
|---|---|
| Summary + key points | ✅ |
| Action item / decision / risk extraction | ✅ |
| **Summary templates — choose per meeting, rewrite afterwards** | ✅ |
| Ask-the-meeting RAG chat (pgvector + citations) | ✅ |
| **Edit the whole transcript in one pass, then Done** | ✅ |
| **Highlights, bookmarks, notes and reactions on any turn** | ✅ |
| **Navigable outline of the meeting, beside the transcript** | ✅ |
| Summary translation, and a translated transcript | ✅ |
| **Read a whole meeting in another language, from the ⋯ menu** | ✅ |
| **Export as PDF · Word · Markdown · plain text, plus the audio** | ✅ |
| Copy the summary to the clipboard | ✅ |
| **One ⋯ menu for everything you do to a meeting** | ✅ |

### Across meetings

| Feature | Status |
|---|---|
| **Ask-everything workspace chat (grounded across all meetings)** | ✅ |
| **Semantic search — find meetings by what was said** | ✅ |
| **Commitment ledger — promises tracked across meetings** | ✅ |
| **Decision drift — flags decisions that contradict earlier ones** | ✅ |
| Action item tracker, with comments | ✅ |
| **Folders — group meetings, ask questions of the whole group** | ✅ |
| **Filter Home by a stretch of time** | ✅ |
| Search & filters | ✅ |

### Telling and settling up

| Feature | Status |
|---|---|
| **Seven email switches under one select-all** | ✅ |
| **In-app notifications, in the left rail** | ✅ |
| Clerk auth (+ dev bypass), two-factor via the account portal | ✅ |
| **Retention policy — erase audio and meetings on a schedule** | ✅ (no UI) |

### Platform

| Feature | Status |
|---|---|
| Kafka async processing + Outbox | ✅ |
| Redis rate limiting + status cache | ✅ |
| WebSocket live progress | ✅ |
| Row-level security, per-user data isolation | ✅ |
| Audit log | ✅ |
| Dark theme | ✅ (the only theme) |

## Development

The ai-service has its own README with local (non-Docker) run instructions:
[ai-service](ai-service/README.md). The other two run with `npm run dev` and
`mvn spring-boot:run`, against the infra services from
`docker compose up postgres redis kafka minio minio-init mailpit`.

### Tests

| Suite | Count | Run it |
|---|---|---|
| `backend-spring` (JUnit) | 715 | `cd backend-spring && mvn test` |
| `frontend` (Vitest) | 890 | `cd frontend && npm test` |
| `ai-service` (pytest) | 361 | `cd ai-service && pytest` |

Counts are from a full run on 19 Aug 2026, not an estimate. `mvn test` reports
`BUILD SUCCESS` against stale classes if `backend-spring/target` is left behind
by a previous run — delete it first when a change should have broken something
and did not.

## Tech / design highlights

- **Design patterns**: Strategy + Factory + Adapter (AI and transcription
  providers), Repository, DTO, Builder (brief response), Observer (Kafka
  consumers), Outbox (reliable events), Circuit Breaker (Resilience4j around AI
  calls).
- **Security**: Clerk JWT validation, Postgres row-level security, private S3
  buckets + short-lived presigned URLs, audit logs, plan-based file/usage limits.
- **Email in dev**: `docker compose` runs [Mailpit](http://localhost:8025), so
  every automatic message is demoable with no SMTP account and no test ever mails
  a real person. Point `SMTP_HOST`/`SMTP_PORT` at a real relay to send for real.
- **Server-side request forgery**: one user-supplied URL is fetched server-side,
  and it is defended by a host allowlist enforced twice — in `MeetingService`
  before the event is published, and in `app/ingest.py` before yt-dlp sees it.

## What is not here, stated honestly

- **No integration tests.** Testcontainers is declared in `backend-spring/pom.xml`
  and no suite uses it. Every backend test is a unit test against mocks.
- **No load tests.** The k6 scripts described in
  [docs/load-testing-report.md](docs/load-testing-report.md) have not been written.
- **No provider is exercised live.** The AssemblyAI and Deepgram adapters have
  tests, but they cover response *mapping* — millisecond-to-second conversion,
  speaker-label normalisation — against recorded payloads. No test makes a real
  call to any provider, including OpenAI.
- **Two capabilities have no interface.** The seven email switches and the
  notification mute switches are settable only through `PATCH /preferences`:
  recap mail, the weekly digest and task reminders still send on whatever is
  stored, and nothing in the app can turn them off. There were five. Retention
  and closing the account are now on Account Settings — General, and the
  account export was removed from the server rather than left unreachable.
- **Erasure has one grain in the UI, and three on the server.** `DELETE` of a
  meeting's audio and of its transcript both work, and the retention job calls
  them; the ⋯ menu offers only "Delete this meeting". A meeting can still turn
  up with its recording already erased, so the page keeps the line saying when
  that happened.
- **A meeting's spoken language cannot be corrected after the fact.**
  `POST /meetings/:id/language` re-transcribes the audio under a language you
  name, and nothing calls it. It was a ⋯ menu item sitting beside the
  translation picker; two controls both saying "language", one of which
  silently destroyed hand-typed transcript corrections. Removed rather than
  renamed. The import dialog's language picker sets the *account* default, not
  a per-meeting one, so today the language is chosen before a meeting is
  enqueued or not at all. "Reprocess meeting" re-runs the pipeline, with
  whatever language the meeting already has.
- **A folder's chat is unreachable, not deleted.** `POST /projects/:id/chat` and
  the whole `PRJ-` scope still work; the UI for them was removed, so existing
  history is stranded rather than erased.
- **Single account per workspace.** No teams, no members, no invitations — which
  is why there is no "someone commented on your meeting", and why the comment
  and highlight emails describe your own activity back to you, capped at one a
  day.
