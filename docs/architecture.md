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
`meeting_uploaded` Kafka event** (via the transactional Outbox). Relays FastAPI
status back to the browser over WebSocket and caches it in Redis. Handles Stripe
billing. Never runs AI itself.

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
FastAPI consumer:
   status TRANSCRIBING ─▶ Whisper ─▶ transcription_completed
   status SUMMARIZING  ─▶ GPT summary ─▶ summary_generated
   status EXTRACTING   ─▶ GPT actions/decisions/risks ─▶ action_items_extracted
   POST /internal/meetings/{id}/result  (persist everything, status=READY)
Spring: relay each status to /topic/meetings/{id} (WS) + Redis cache
Browser: live timeline ─▶ Meeting Brief Ready
```

Failure at any step → `meeting_processing_failed` → Spring marks meeting FAILED,
stores `error_message`, WS pushes FAILED. User can `POST /meetings/{id}/reprocess`.

## Why this shape
- **Two languages on purpose**: Java for transactional business/billing/security,
  Python for the AI ecosystem. Mirrors real GenAI product teams.
- **Kafka, not direct calls**: decouples slow AI work from the request thread,
  survives worker restarts, gives an event log. Outbox pattern guarantees the
  event is published iff the DB write commits.
- **Presigned uploads**: large media bypasses the JVM; the API only handles metadata.
- **Redis**: rate limiting (token bucket per user/plan), status cache (polling
  fallback + fast dashboard), usage counters.

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
