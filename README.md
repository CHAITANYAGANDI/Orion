# Recallix AI

> Turn meeting audio into accurate transcripts, concise summaries, decisions, risks, and trackable action items.

Recallix AI is a production-style, multi-service SaaS. Bring a meeting in —
upload audio or video, record a tab live, paste a YouTube link, or drop in a PDF
of typed-up minutes — and it transcribes, summarizes, and extracts decisions /
action items / risks, streams live progress over WebSockets, and tracks
commitments and decision drift *across* meetings.

## Architecture

```
Next.js Frontend ──Clerk JWT──▶ Spring Boot API ──┬── PostgreSQL
   ▲  (STOMP/WS status)                            ├── Redis (status/rate limit)
   │                                               ├── Stripe (billing)
   └───────────────── WebSocket ◀──────────────────┤── S3 / MinIO (audio)
                                                    │
                                    Kafka: meeting_uploaded
                                                    ▼
                                     Python FastAPI AI Worker
                                       ├── Whisper (transcription)
                                       ├── GPT (summary + extraction, run in parallel)
                                       ├── pgvector (chunk + embed for RAG)
                                       └── callback ──▶ Spring (persist result)
```

| Service | Stack | Port |
|---|---|---|
| `frontend/` | Next.js, React, TypeScript, Redux Toolkit, Tailwind, shadcn/ui | 3000 |
| `backend-spring/` | Java 21, Spring Boot 3, Spring Security, Spring Kafka, JPA, Flyway | 8080 |
| `ai-service/` | Python 3.12, FastAPI, OpenAI, aiokafka | 8000 |
| infra | Postgres 16, Redis 7, Kafka (KRaft), MinIO (S3) | — |

## Quick start

```bash
cp .env.example .env         # defaults run with NO external keys (dev auth + mock AI)
docker compose up --build
```

- Frontend:  http://localhost:3000
- Spring API: http://localhost:8080/actuator/health · Swagger: http://localhost:8080/swagger-ui.html
- AI service: http://localhost:8000/health · Docs: http://localhost:8000/docs
- MinIO console: http://localhost:9001 (minioadmin / minioadmin)
- **Mailpit** (catches every recap email): http://localhost:8025

The stack runs end-to-end out of the box: **dev auth** (no Clerk account needed)
and **mock AI** (deterministic transcript/summary, no OpenAI key). To enable the
real pipeline set `AI_PROVIDER=openai` + `OPENAI_API_KEY`, and/or
`RECALLIX_AUTH_MODE=clerk` with Clerk env vars. See [.env.example](.env.example).

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
- [Database schema](docs/database-schema.sql)
- [Phase 2: AI Agent + MCP](docs/phase2-agent-mcp.md)
- [Demo script](docs/demo-script.md)
- [Load testing](docs/load-testing-report.md) — test plan; not yet run

## Feature status

| Feature | Status |
|---|---|
| Audio upload (S3 presigned) | ✅ |
| **YouTube import — paste a link, no upload** | ✅ |
| **PDF import — summarise typed-up minutes** | ✅ |
| Transcription (Whisper / mock) | ✅ |
| Summary + key points | ✅ |
| Action item / decision / risk extraction | ✅ |
| Action item tracker | ✅ |
| Ask-the-meeting RAG chat (pgvector + citations) | ✅ |
| **Ask-everything workspace chat (grounded across all meetings)** | ✅ |
| **Semantic search — find meetings by what was said** | ✅ |
| **Commitment ledger — promises tracked across meetings** | ✅ |
| **Decision drift — flags decisions that contradict earlier ones** | ✅ |
| Summary translation | ✅ |
| Speaker renaming | ✅ |
| Kafka async processing + Outbox | ✅ |
| Redis rate limiting + status cache | ✅ |
| WebSocket live progress | ✅ |
| Stripe billing (checkout + webhook) | ✅ (test mode) |
| Markdown export · PDF via browser print | ✅ |
| Read-only public share links (revocable) | ✅ |
| AI-drafted follow-up email | ✅ |
| **Recap emailed automatically when processing finishes** | ✅ |
| **Non-English meetings — brief written in the spoken language** | ✅ |
| Live in-browser recording (microphone) | ✅ |
| Search & filters | ✅ |
| Clerk auth (+ dev bypass) | ✅ |
| Speaker diarization | ⚪ optional |

## Development

Each service has its own README with local (non-Docker) run instructions:
[frontend](frontend/README.md) · [backend-spring](backend-spring/README.md) · [ai-service](ai-service/README.md).

## Tech / design highlights

- **Design patterns**: Strategy + Factory + Adapter (AI providers), Repository, DTO,
  Builder (brief response), Observer (Kafka consumers), Outbox (reliable events),
  Circuit Breaker (Resilience4j around AI calls).
- **Security**: Clerk JWT validation, per-user data isolation, private S3 buckets +
  short-lived presigned URLs, audit logs, plan-based file/usage limits.
- **Testing**: pytest covers the ai-service — schema/camelCase contracts, the full
  mock pipeline, Meeting Memory's verdict and drift logic, and the import
  allowlist. JUnit covers the Spring domain helpers, `MemoryService`,
  `ShareService`, URL imports, the recap email guards and transcript editing.
  Run them with `cd ai-service && pytest` and `cd backend-spring && mvn test`.
- **Email in dev**: `docker compose` runs [Mailpit](http://localhost:8025), so the
  recap feature is demoable with no SMTP account and no test ever mails a real
  person. Point `SMTP_HOST`/`SMTP_PORT` at a real relay to send for real.
- **Server-side request forgery**: one user-supplied URL is fetched server-side,
  and it is defended by a host allowlist enforced twice — in `MeetingService`
  before the event is published, and in `app/ingest.py` before yt-dlp sees it.

> **Test coverage is partial and stated honestly.** Testcontainers is declared in
> `pom.xml` but no integration suite uses it yet, there are no frontend tests, and
> the k6 load scripts described in [docs/load-testing-report.md](docs/load-testing-report.md)
> have not been written. The OpenAI provider path is also unexercised — every test
> runs against the mock provider.
