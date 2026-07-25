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
| Method | Endpoint | Body / Query | Response |
|---|---|---|---|
| POST | `/api/v1/meetings/upload-url` | `{ "filename", "contentType", "sizeBytes" }` | `{ "meetingId", "uploadUrl", "objectKey", "expiresInSeconds" }` |
| POST | `/api/v1/meetings` | `MeetingCreateRequest` | `MeetingResponse` |
| GET  | `/api/v1/meetings` | `?page&size&search&tag&status` | `Page<MeetingResponse>` |
| GET  | `/api/v1/meetings/{id}` | — | `MeetingResponse` |
| GET  | `/api/v1/meetings/{id}/transcript` | — | `TranscriptResponse` |
| GET  | `/api/v1/meetings/{id}/summary` | — | `SummaryResponse` |
| GET  | `/api/v1/meetings/{id}/action-items` | — | `ActionItemResponse[]` |
| GET  | `/api/v1/meetings/{id}/decisions` | — | `DecisionResponse[]` |
| GET  | `/api/v1/meetings/{id}/risks` | — | `RiskResponse[]` |
| POST | `/api/v1/meetings/{id}/reprocess` | — | `202 { "meetingId","status" }` |
| DELETE | `/api/v1/meetings/{id}` | — | `204` |

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
| POST | `/ai/summarize` | `{ "transcript" }` | `{ "shortSummary","detailedSummary","keyPoints":[] }` |
| POST | `/ai/extract-action-items` | `{ "transcript" }` | `{ "actionItems":[ActionItem] }` |
| POST | `/ai/extract-decisions` | `{ "transcript" }` | `{ "decisions":[Decision] }` |
| POST | `/ai/extract-risks` | `{ "transcript" }` | `{ "risks":[Risk] }` |
| POST | `/ai/process-meeting` | `{ "meetingId","audioUrl" }` | `MeetingBriefResult` (also persisted via callback) |
| GET  | `/health` | — | `{ "status":"ok","provider":"openai\|mock" }` |

---

## 5. Canonical JSON shapes (used by ALL services)

```jsonc
// ActionItem
{ "taskTitle": "Finish JWT validation", "ownerName": "Chaitanya",
  "dueDate": "Friday", "priority": "high|medium|low",
  "sourceSentence": "Chaitanya will finish JWT validation by Friday." }

// Decision
{ "decision": "Use AWS S3 for meeting audio storage.",
  "confidence": "high|medium|low",
  "sourceSentence": "Let's store the meeting audio in S3." }

// Risk
{ "risk": "Large audio files may slow down processing.",
  "severity": "high|medium|low", "sourceSentence": "..." }

// MeetingBriefResult (FastAPI -> Spring callback + /ai/process-meeting response)
{ "meetingId": "mtg_123",
  "transcript": "full text ...",
  "language": "en",
  "segments": [ { "start": 0.0, "end": 3.2, "speaker": "S1", "text": "..." } ],
  "shortSummary": "...",
  "detailedSummary": "...",
  "keyPoints": [ "..." ],
  "decisions": [ /* Decision */ ],
  "actionItems": [ /* ActionItem */ ],
  "risks": [ /* Risk */ ] }
```

### MeetingResponse (Spring -> frontend)
```jsonc
{ "id": "mtg_123", "title": "Sprint Planning", "status": "READY",
  "participants": ["Alice","Bob"], "tags": ["sprint"],
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
