"""Internal HTTP callbacks to Spring Boot (X-Internal-Token authenticated).

FastAPI pushes status updates and the final result to Spring's internal
endpoints (api-contracts.md §3).

Every post says what became of it, and nothing here raises: a progress update
that fails is genuinely not worth failing a meeting over, and the pipeline
ignores those answers. The two that matter are the ones that establish a
terminal outcome -- the result, and the READY or FAILED status beside it --
because the Kafka worker commits its offset only once Spring has taken them.
Swallowing those silently, as this once did, is what made a lost callback
indistinguishable from a delivered one.

**Three answers, not two.** "It did not land" and "Spring read it and said no"
call for opposite reactions, and collapsing them into a boolean makes one of the
two wrong. A callback that could not be delivered has to be retried, because the
work is real and unrecorded. A callback Spring *refused* -- a run overtaken by a
reprocess, a payload it will not accept -- will be refused identically for ever,
so retrying it holds a single-partition topic behind a message that can never
make progress.

Every post also names the processing run it belongs to, so Spring can tell the
run in flight from one that a reprocess has since replaced. See
`CallbackService` for what it does with that.
"""

from __future__ import annotations

import logging
from enum import Enum

import httpx

from app.config import Settings
from app.schemas import MeetingBriefResult, StatusEvent

logger = logging.getLogger("ai-service.callback")


#: Statuses worth sending again. Everything else in the 4xx range means the
#: request itself was wrong, and it will be just as wrong in ten seconds.
RETRYABLE_STATUS = frozenset({408, 425, 429})


class Delivery(Enum):
    """What happened to one callback."""

    #: Spring took it. Whatever it establishes is now in Postgres.
    ACCEPTED = "accepted"
    #: Spring read it and declined it, permanently. Sending it again is pointless.
    REFUSED = "refused"
    #: Nobody can say. It may or may not have landed, so it has to be sent again.
    UNDELIVERED = "undelivered"

    @property
    def accepted(self) -> bool:
        return self is Delivery.ACCEPTED


class SpringCallbackClient:
    """Posts status + result callbacks to Spring's `/internal/**` endpoints."""

    def __init__(self, settings: Settings) -> None:
        self._base = settings.spring_callback_url.rstrip("/")
        self._headers = {"X-Internal-Token": settings.recallix_internal_token}
        self._timeout = 15.0

    async def post_status(
        self, meeting_id: str, event: StatusEvent, *, attempt: int | None = None
    ) -> Delivery:
        """Report a stage of one processing run."""
        url = f"{self._base}/internal/meetings/{meeting_id}/status"
        payload = event.model_dump(by_alias=True, exclude={"meeting_id"})
        return await self._post(url, payload, label="status", attempt=attempt)

    async def post_result(
        self, meeting_id: str, result: MeetingBriefResult, *, attempt: int | None = None
    ) -> Delivery:
        """Hand over the brief one processing run produced."""
        url = f"{self._base}/internal/meetings/{meeting_id}/result"
        payload = result.model_dump(by_alias=True)
        return await self._post(url, payload, label="result", attempt=attempt)

    async def _post(
        self, url: str, payload: dict, *, label: str, attempt: int | None = None
    ) -> Delivery:
        if attempt is not None:
            # Merged here rather than carried on the models: `MeetingBriefResult`
            # is also the body of POST /ai/process-meeting, which has no Kafka
            # message behind it and no run to name.
            payload = {**payload, "processingAttempt": attempt}
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.post(url, json=payload, headers=self._headers)
                resp.raise_for_status()
                logger.info("Spring callback (%s) ok: %s", label, resp.status_code)
                return Delivery.ACCEPTED
        except httpx.HTTPStatusError as exc:
            code = exc.response.status_code
            if 400 <= code < 500 and code not in RETRYABLE_STATUS:
                logger.warning(
                    "Spring refused the %s callback to %s with %s: %s",
                    label, url, code, exc.response.text[:400],
                )
                return Delivery.REFUSED
            logger.warning("Spring callback (%s) to %s failed: %s", label, url, exc)
            return Delivery.UNDELIVERED
        except Exception as exc:  # noqa: BLE001 — callbacks must not crash the pipeline.
            logger.warning("Spring callback (%s) to %s failed: %s", label, url, exc)
            return Delivery.UNDELIVERED
