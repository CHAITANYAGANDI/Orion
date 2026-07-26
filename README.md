# Recallix AI

> Turn meeting audio into accurate transcripts, concise summaries, decisions, risks, and trackable action items.

Recallix AI is a production-style, multi-service SaaS. Upload meeting audio → it
transcribes, summarizes, and extracts decisions / action items / risks, streams
live progress over WebSockets, and lets you track and export the results.

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

The stack runs end-to-end out of the box: **dev auth** (no Clerk account needed)
and **mock AI** (deterministic transcript/summary, no OpenAI key). To enable the
real pipeline set `AI_PROVIDER=openai` + `OPENAI_API_KEY`, and/or
`RECALLIX_AUTH_MODE=clerk` with Clerk env vars. See [.env.example](.env.example).

## Docs

- [Architecture](docs/architecture.md)
- [API contracts](docs/api-contracts.md) — REST, Kafka, WebSocket, JSON shapes (source of truth)
- [Database schema](docs/database-schema.sql)
- [Phase 2: AI Agent + MCP](docs/phase2-agent-mcp.md)
- [Demo script](docs/demo-script.md)
- [Load testing](docs/load-testing-report.md)

## Feature status

| Feature | Status |
|---|---|
| Audio upload (S3 presigned) | ✅ |
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
| PDF / Markdown export | ✅ |
| Search & filters | ✅ |
| Clerk auth (+ dev bypass) | ✅ |
| Speaker diarization | ⚪ optional |
| AI Agent + MCP integrations | 🟡 Phase 2 scaffold (approval workflow, draft plans) |

## Development

Each service has its own README with local (non-Docker) run instructions:
[frontend](frontend/README.md) · [backend-spring](backend-spring/README.md) · [ai-service](ai-service/README.md).

## Tech / design highlights

- **Design patterns**: Strategy + Factory + Adapter (AI providers), Repository, DTO,
  Builder (brief response), Observer (Kafka consumers), Outbox (reliable events),
  Circuit Breaker (Resilience4j around AI calls).
- **Security**: Clerk JWT validation, per-user data isolation, private S3 buckets +
  short-lived presigned URLs, audit logs, plan-based file/usage limits.
- **Testing**: JUnit + Testcontainers (Postgres/Kafka/Redis), pytest (AI schemas),
  k6 load scripts under `backend-spring/load-testing/`.
