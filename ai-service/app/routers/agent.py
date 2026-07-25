"""Phase 2 — AI agent scaffolding (docs/phase2-agent-mcp.md).

Mock implementation: `/ai/agent/plan-actions` returns a structured plan of DRAFT
actions derived from the brief; `/ai/agent/validate-action` performs a simple
safety check. No external side effects — execution is stubbed and gated behind
human approval in Spring.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.schemas import (
    ActionPlan,
    PlanActionsRequest,
    PlannedAction,
    ValidateActionRequest,
    ValidateActionResponse,
)

router = APIRouter(prefix="/ai/agent", tags=["agent"])

# Tools that must never execute silently (emails require explicit approval).
_SEND_TYPES = {"SEND_EMAIL", "SEND_GMAIL_EMAIL", "SEND_OUTLOOK_EMAIL"}


@router.post("/plan-actions", response_model=ActionPlan)
async def plan_actions(body: PlanActionsRequest) -> ActionPlan:
    """Return a draft action plan derived from a meeting brief + instruction."""
    brief = body.brief
    title = "Meeting"
    task_count = 0
    if brief is not None:
        # Use the short summary's leading clause as a human-friendly title.
        title = (brief.short_summary or "Meeting").split(":")[0].strip()[:80] or "Meeting"
        task_count = len(brief.action_items)

    actions = [
        PlannedAction(
            type="CREATE_NOTION_NOTE",
            provider="notion",
            title=f"{title} - Notes",
            status="DRAFT",
        ),
        PlannedAction(
            type="DRAFT_EMAIL",
            provider="gmail",
            subject="Follow-up: Decisions and Next Steps",
            status="DRAFT",
        ),
        PlannedAction(
            type="CREATE_TASKS",
            provider="microsoft_tasks",
            task_count=task_count or 4,
            status="DRAFT",
        ),
        PlannedAction(
            type="CREATE_CALENDAR_EVENT",
            provider="google_calendar",
            title=f"{title} Follow-up",
            status="DRAFT",
        ),
    ]
    return ActionPlan(meeting_id=body.meeting_id, requires_approval=True, actions=actions)


@router.post("/validate-action", response_model=ValidateActionResponse)
async def validate_action(body: ValidateActionRequest) -> ValidateActionResponse:
    """Safety check before an approved action is executed (mock)."""
    action = body.action
    if action.type in _SEND_TYPES:
        return ValidateActionResponse(
            valid=False,
            reason="Send actions require explicit human approval and cannot be auto-validated.",
        )
    if not action.provider:
        return ValidateActionResponse(valid=False, reason="Action is missing a provider.")
    return ValidateActionResponse(
        valid=True,
        reason=f"Action '{action.type}' for provider '{action.provider}' is a safe draft.",
    )
