# Reverie AI — Architecture

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

## Delivery guarantees

Each leg, stated as what it actually is rather than what would be nice:

| Leg | Guarantee |
|---|---|
| meeting transaction → outbox | **Atomic.** The business rows and the event row commit together or not at all; that is the whole point of the pattern. |
| outbox → Kafka | **At-least-once, concurrency-safe.** Rows are claimed with `FOR UPDATE SKIP LOCKED`, so two relays never own the same row and different meetings progress in parallel. Kafka acknowledges before the row is marked, so a crash in between republishes. **Not exactly-once.** |
| Kafka → AI worker | **At-least-once.** Manual offset commits, only after Spring has accepted a terminal outcome, so a worker that dies mid-run replays rather than losing the meeting. |
| worker → callbacks | **At-least-once, idempotent per attempt.** Every callback carries the `processingAttempt` it belongs to; a run the meeting has moved past is discarded, and one claiming a run the meeting has not reached is refused. |
| callback durable effects | **Idempotent per attempt.** Transcript, segments, summary and insights are replaced wholesale; AI minutes are claimed through a primary key that includes the attempt; notifications carry an attempt-scoped dedupe key. |
| RAG effects | **Generation-scoped and concurrency-safe.** Chunks carry the run that produced them, writes are scoped to that run, and the meeting row is locked for the duration of the write so an overtaken run cannot replace a newer one's chunks. Retrieval reads the newest generation present. |

Publication failures are separated by cause. A payload that can never be
published — too large, unserialisable, an illegal topic name — retires the row:
`failed_at` is set, the row is kept for inspection, it is never claimed again,
and it stops blocking later events for the same meeting. The meeting behind it
is failed rather than left waiting. Everything else — timeouts, disconnects,
expired credentials, anything unrecognised — retries with a durable backoff of
5s doubling to a 5-minute ceiling, indefinitely, and is never discarded.

## Why this shape
- **Two languages on purpose**: Java for transactional business/billing/security,
  Python for the AI ecosystem. Mirrors real GenAI product teams.
- **Kafka, not direct calls**: decouples slow AI work from the request thread,
  survives worker restarts, gives an event log. Outbox pattern guarantees the
  event is published iff the DB write commits.
- **Presigned uploads**: large media bypasses the JVM; the API only handles metadata.
- **No Redis**: the one counter it held — burst protection on the
  streaming-token endpoint — is a map in the backend and cannot be unavailable.
  Being in-process makes it per-instance, which is the one thing a second
  backend changes. Status is read from Postgres, which always was the source of
  truth.
- **The outbox is safe on every instance**: the relay claims rows with
  `FOR UPDATE SKIP LOCKED`, so two backends divide the backlog rather than both
  publishing it. See "Delivery guarantees" below.

## Design patterns (where)
| Pattern | Location |
|---|---|
| Strategy | `AiProvider` (OpenAI vs Mock) in ai-service; summary strategies |
| Factory | `AiProviderFactory` selects provider from `AI_PROVIDER` |
| Adapter | Whisper/GPT wrapped behind `TranscriptionPort`/`LlmPort` |
| Repository | `*Repository` (Spring Data JPA) |
| DTO | request/response records separate from `@Entity` |
| Builder | `MeetingBriefResponse` assembly |
| Observer/Event | Spring `ApplicationEventPublisher` (`MeetingReadyEvent`, `OutboxEventRetired`); the Kafka consumer is in the ai-service |
| Outbox | `outbox_events` + scheduled relay publisher, claimed with `FOR UPDATE SKIP LOCKED` |
| Circuit Breaker | Resilience4j around FastAPI/OpenAI calls |
| Decorator / policy | premium checks around export & long audio |

## Auth modes
- `dev`: `X-Dev-User` header → user upserted. No Clerk needed. For local/demo.
- `clerk`: Bearer Clerk JWT validated against Clerk JWKS; `sub` → `clerk_user_id`.
