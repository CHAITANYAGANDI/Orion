"""Internal HTTP callbacks to Spring Boot (X-Internal-Token authenticated).

FastAPI pushes status updates and the final result to Spring's internal
endpoints (api-contracts.md §3). Failures are logged but never raised into the
pipeline — Kafka events remain the source of truth for observability.
"""

from __future__ import annotations

import logging

import httpx

from app.config import Settings
from app.schemas import MeetingBriefResult, StatusEvent

logger = logging.getLogger("ai-service.callback")


class SpringCallbackClient:
    """Posts status + result callbacks to Spring's `/internal/**` endpoints."""

    def __init__(self, settings: Settings) -> None:
        self._base = settings.spring_callback_url.rstrip("/")
        self._headers = {"X-Internal-Token": settings.recallix_internal_token}
        self._timeout = 15.0

    async def post_status(self, meeting_id: str, event: StatusEvent) -> None:
        url = f"{self._base}/internal/meetings/{meeting_id}/status"
        payload = event.model_dump(by_alias=True, exclude={"meeting_id"})
        await self._post(url, payload, label="status")

    async def post_result(self, meeting_id: str, result: MeetingBriefResult) -> None:
        url = f"{self._base}/internal/meetings/{meeting_id}/result"
        payload = result.model_dump(by_alias=True)
        await self._post(url, payload, label="result")

    async def _post(self, url: str, payload: dict, *, label: str) -> None:
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.post(url, json=payload, headers=self._headers)
                resp.raise_for_status()
                logger.info("Spring callback (%s) ok: %s", label, resp.status_code)
        except Exception as exc:  # noqa: BLE001 — callbacks must not crash the pipeline.
            logger.warning("Spring callback (%s) to %s failed: %s", label, url, exc)
