# Recallix AI — `ai-service`

FastAPI **AI worker** for Recallix AI. It is stateless compute: it transcribes
meeting audio (Whisper), summarizes it, and extracts action items, decisions,
and risks (GPT) — exposing every step as an HTTP endpoint and also running the
full pipeline off a Kafka queue.

It conforms exactly to the shared contracts in
[`docs/api-contracts.md`](../docs/api-contracts.md) (§4, §5, §6) and
[`docs/architecture.md`](../docs/architecture.md).

## What it does

- **HTTP API** (`/ai/*`) — synchronous transcription / summarization /
  extraction and a one-shot `/ai/process-meeting`.
- **Kafka worker** — consumes `meeting_uploaded`, runs the pipeline, emits
  `StatusEvent`s to `transcription_started` / `transcription_completed` /
  `summary_generated` / `action_items_extracted` (and `meeting_processing_failed`
  on error), and posts progress + the final `MeetingBriefResult` back to Spring's
  internal callback.
- **Providers** — swap between a **deterministic mock** (default, no API key) and
  **OpenAI** via a single env var, using Strategy + Factory + Adapter patterns.

## Design patterns

| Pattern | Where |
|---|---|
| Strategy | `TranscriptionPort` / `LlmPort` chosen at runtime |
| Factory | `AiProviderFactory` picks adapters from `AI_PROVIDER` |
| Adapter | `OpenAi*Adapter` / `Mock*Adapter` wrap Whisper/GPT behind the ports |
| Circuit breaker | bounded retries + timeout + empty-result fallback around OpenAI calls |

## Layout

```
app/
  main.py            FastAPI app, lifespan, Kafka worker startup
  config.py          pydantic-settings (env vars)
  schemas.py         canonical camelCase Pydantic models (§5)
  routers/ai.py      §4 HTTP endpoints
  routers/agent.py   Phase 2 agent scaffolding
  providers/         ports.py, mock_adapter.py, openai_adapter.py, factory.py
  pipeline.py        transcribe -> summarize -> extract orchestration
  kafka_worker.py    resilient aiokafka consumer/producer
  callback.py        POSTs to Spring /internal/**
  storage.py         audio download (httpx URL / boto3 S3)
tests/               pytest (mock, offline)
```

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `KAFKA_BOOTSTRAP_SERVERS` | `localhost:9092` | Kafka brokers |
| `SPRING_CALLBACK_URL` | `http://localhost:8080` | Spring base URL for callbacks |
| `RECALLIX_INTERNAL_TOKEN` | `dev-internal-token` | `X-Internal-Token` shared secret |
| `AI_PROVIDER` | `mock` | `mock` or `openai` |
| `OPENAI_API_KEY` | — | required when `AI_PROVIDER=openai` |
| `OPENAI_TRANSCRIBE_MODEL` | `whisper-1` | Whisper model |
| `OPENAI_CHAT_MODEL` | `gpt-5.6-terra` | chat model for summary/extraction |
| `OPENAI_EXTRACTION_MODEL` | `gpt-5.6-luna` | model for action items, decisions and risks |
| `S3_ENDPOINT` | — | MinIO/S3 endpoint (for `objectKey` downloads) |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | — | S3 credentials |
| `S3_BUCKET` | `recallix` | audio bucket |

The service boots in **mock mode with no external dependencies** — Kafka and
OpenAI are both optional to start it.

## Endpoints (§4)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | `{"status":"ok","provider":"mock|openai"}` |
| POST | `/ai/transcribe` | `{audioUrl|audioPath}` → transcript + segments |
| POST | `/ai/summarize` | `{transcript}` → short/detailed summary + key points |
| POST | `/ai/extract-action-items` | `{transcript}` → `{actionItems[]}` |
| POST | `/ai/extract-decisions` | `{transcript}` → `{decisions[]}` |
| POST | `/ai/extract-risks` | `{transcript}` → `{risks[]}` |
| POST | `/ai/process-meeting` | `{meetingId,audioUrl}` → `MeetingBriefResult` |
| POST | `/ai/agent/plan-actions` | Phase 2: draft action plan (mock) |
| POST | `/ai/agent/validate-action` | Phase 2: safety check (mock) |

Interactive docs at `http://localhost:8000/docs`.

## Run locally

```bash
python -m venv .venv && source .venv/Scripts/activate   # Windows Git Bash
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Then:

```bash
curl http://localhost:8000/health
curl -X POST http://localhost:8000/ai/process-meeting \
  -H 'content-type: application/json' -d '{"meetingId":"mtg_1"}'
```

## Run with Docker

```bash
docker build -t recallix-ai-service .
docker run --rm -p 8000:8000 -e AI_PROVIDER=mock recallix-ai-service
```

Or via the repo's `docker-compose.yml` (`ai-service` service).

## Switching mock ↔ OpenAI

Default is `mock` (deterministic, offline). To use OpenAI:

```bash
export AI_PROVIDER=openai
export OPENAI_API_KEY=sk-...
# optional: OPENAI_TRANSCRIBE_MODEL, OPENAI_CHAT_MODEL
uvicorn app.main:app --reload
```

Extraction uses OpenAI **JSON mode** with prompts that instruct the model to
extract only what is explicitly in the transcript and to quote the exact source
sentence. OpenAI calls are wrapped in bounded retries + a timeout; on failure
they degrade to an empty structured result instead of a 500.

## Tests

```bash
pip install -r requirements.txt   # includes pytest, pytest-asyncio
pytest
```

Tests run fully offline with `AI_PROVIDER=mock`: they check `/health`, that the
mock pipeline output validates against the Pydantic schemas with camelCase keys,
and that every extraction/agent endpoint returns the right shape.
