# Recallix AI — Architecture

## Services & responsibilities

### 1. `frontend/` — Next.js (App Router)
Presentation only. Talks to Spring Boot over REST + one STOMP/SockJS WebSocket for
live processing status. Uploads audio directly to S3 via a presigned URL (bytes
never pass through the app servers). Redux Toolkit for meetings/action-items/usage
slices; RTK Query for the API client.

### 2. `backend-spring/` — Spring Boot (system of record + orchestrator)
Owns all business data and rules. Validates auth, enforces usage limits, generates
presigned URLs, persists meetings, and **kicks off processing by publishing a
`meeting_uploaded` Kafka event** (via the transactional Outbox). Persists each
FastAPI status callback and relays it to the browser over WebSocket. Never runs
AI itself.

### 3. `ai-service/` — FastAPI (AI worker)
Stateless compute. Consumes `meeting_uploaded`, downloads audio from S3,
transcribes (Whisper), summarizes, and extracts decisions/action items/risks
(GPT), emitting status events to Kafka along the way. On completion it POSTs the
full `MeetingBriefResult` back to Spring's internal callback, which persists it.
Also exposes the same steps as synchronous HTTP endpoints for testing.

## Processing flow

```
User picks audio ─▶ POST /meetings/upload-url ─▶ presigned PUT to S3
                 ─▶ POST /meetings (metadata, status=UPLOADED)
Spring: check usage limit ─▶ write outbox row ─▶ publish meeting_uploaded
FastAPI consumer (each stage POSTs /internal/meetings/{id}/status):
   status TRANSCRIBING ─▶ transcribe
   status SUMMARIZING  ─▶ GPT summary
   status EXTRACTING   ─▶ GPT action items
   POST /internal/meetings/{id}/result  (persist everything, status=READY)
Spring: persist each status, relay to /topic/meetings/{id} (WS)
Browser: live timeline ─▶ Meeting Brief Ready
```

Failure at any step → the worker POSTs status FAILED to the same callback →
Spring marks the meeting FAILED, stores `error_message`, raises a notification
and pushes FAILED over WS. User can `POST /meetings/{id}/reprocess`.

`meeting_uploaded` is the only Kafka topic. The stage events above were once
published to a topic each as well; nothing consumed them but a logger, so they
were removed and the HTTP callback beside each one is now the only report.

## Why this shape
- **Two languages on purpose**: Java for transactional business/billing/security,
  Python for the AI ecosystem. Mirrors real GenAI product teams.
- **Kafka, not direct calls**: decouples slow AI work from the request thread,
  survives worker restarts, gives an event log. Outbox pattern guarantees the
  event is published iff the DB write commits.
- **Presigned uploads**: large media bypasses the JVM; the API only handles metadata.
- **No Redis**: the one counter it held — burst protection on the
  streaming-token endpoint — is a map in the backend, which is exactly as
  correct while the backend runs as a single instance, and cannot be
  unavailable. Status is read from Postgres, which always was the source of
  truth.

## Design patterns (where)
| Pattern | Location |
|---|---|
| Strategy | `AiProvider` (OpenAI vs Mock) in ai-service; summary strategies |
| Factory | `AiProviderFactory` selects provider from `AI_PROVIDER` |
| Adapter | Whisper/GPT wrapped behind `TranscriptionPort`/`LlmPort` |
| Repository | `*Repository` (Spring Data JPA) |
| DTO | request/response records separate from `@Entity` |
| Builder | `MeetingBriefResponse` assembly |
| Observer/Event | `@KafkaListener` consumers |
| Outbox | `outbox_events` + scheduled relay publisher |
| Circuit Breaker | Resilience4j around FastAPI/OpenAI calls |
| Decorator / policy | premium checks around export & long audio |

## Auth modes
- `dev`: `X-Dev-User` header → user upserted. No Clerk needed. For local/demo.
- `clerk`: Bearer Clerk JWT validated against Clerk JWKS; `sub` → `clerk_user_id`.
