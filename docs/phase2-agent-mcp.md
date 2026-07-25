# Phase 2 — AI Agent + MCP Productivity Extension

> Status: **scaffolded**. The planning + human-in-the-loop approval workflow is
> implemented against the DB and API; external provider execution is stubbed
> (returns simulated results and logs to `external_sync_logs`). Wiring real
> OAuth/MCP tool servers for Notion/Google/Microsoft is the remaining work.

## Idea
After Recallix AI reliably produces a meeting brief, an AI Agent turns those
outcomes into real productivity actions — with explicit user approval before any
external side effect.

## Controlled tools (MCP-style)
`create_notion_note`, `create_notion_todo`, `draft_gmail_email`, `send_gmail_email`,
`draft_outlook_email`, `send_outlook_email`, `create_google_calendar_event`,
`create_outlook_event`, `create_microsoft_task`.

The agent chooses among these tools; the backend validates and executes **only
after** the user approves. Emails are **never** sent silently.

## Endpoints (implemented, execution stubbed)
| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/v1/integrations` | list connections + status |
| POST | `/api/v1/integrations/{provider}/connect` | begin OAuth/MCP connect (stub returns CONNECTED in dev) |
| DELETE | `/api/v1/integrations/{provider}` | disconnect / revoke |
| POST | `/api/v1/meetings/{id}/agent/plan` | generate draft action plan from the brief |
| GET | `/api/v1/agent/actions` | list DRAFT/APPROVED/EXECUTED/FAILED/REJECTED |
| POST | `/api/v1/agent/actions/{id}/approve` | approve one drafted action |
| POST | `/api/v1/agent/actions/{id}/execute` | execute an approved action |

Plan generation calls FastAPI `/ai/agent/plan-actions` (meeting brief + instruction
→ structured drafts). `/ai/agent/validate-action` performs a safety check before
execution.

## Approval flow
1. User opens a processed meeting, clicks **Ask Agent / Create Follow-ups**.
2. Agent reads brief + instruction, returns a plan of `DRAFT` actions.
3. UI shows each as an editable draft (email/task/meeting/note).
4. User edits or rejects individual actions, then approves selected ones.
5. Backend executes approved actions via connectors, stores status + audit logs.

## Security model
- OAuth least-privilege scopes per provider; tokens in a secrets manager /
  encrypted token store, never in app tables or git.
- Human-in-the-loop mandatory for all external side effects.
- Every external call logged with provider, user, meeting, payload summary,
  status, timestamp (`external_sync_logs`).
- Disconnect/revoke available per integration.

## Agent plan JSON (example)
```json
{ "meetingId": "mtg_123", "requiresApproval": true,
  "actions": [
    { "type": "CREATE_NOTION_NOTE", "provider": "notion", "title": "Sprint Planning - Notes", "status": "DRAFT" },
    { "type": "DRAFT_EMAIL", "provider": "gmail", "subject": "Follow-up: Decisions and Next Steps", "status": "DRAFT" },
    { "type": "CREATE_TASKS", "provider": "microsoft_tasks", "taskCount": 4, "status": "DRAFT" },
    { "type": "CREATE_CALENDAR_EVENT", "provider": "google_calendar", "title": "Sprint Follow-up", "status": "DRAFT" }
  ] }
```
