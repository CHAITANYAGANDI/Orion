"""Short-lived credentials for the browser's live transcription session.

The browser streams microphone audio straight to AssemblyAI during a meeting.
That is the right shape — relaying every 50 ms frame through Recallix would add
a hop to the one part of the product where latency is the whole feature — but it
means a credential has to reach JavaScript, and `ASSEMBLYAI_API_KEY` must never
be it. A key in a bundle is a key in every user's devtools, valid for every
account, until somebody notices.

So: the key stays here, and this mints a token that is useless in almost every
respect. It authorises opening one streaming session, it expires in under a
minute, and it cannot read a transcript, submit a job or spend anything else on
the account.

**Nothing about the token is stored.** Not in Postgres, not in a cache, not in a
log line. There is no revocation list because there is nothing worth revoking
for the seconds it lives, and a token written down somewhere is a token that
outlives its own expiry.

Reached only from Spring, over the internal network, after Spring has
authenticated the user and rate-limited them. This service is not exposed to
browsers.
"""

from __future__ import annotations

import logging

import httpx

from app.config import Settings

logger = logging.getLogger("ai-service.streaming")

TOKEN_URL = "https://streaming.assemblyai.com/v3/token"

#: Long enough to open a websocket on a slow connection, short enough that a
#: token copied out of a network tab is expired before it can be pasted
#: anywhere. The provider validates 1..600 and answers 422 outside that.
DEFAULT_TTL_SECONDS = 45
MIN_TTL_SECONDS = 1
MAX_TTL_SECONDS = 600

#: How long the session opened with it may run. A meeting is long; this is not
#: the token's lifetime, it is the session's, and the provider caps it at three
#: hours. Set explicitly so a runaway tab cannot hold a session open for the
#: maximum by default.
DEFAULT_SESSION_SECONDS = 4 * 60 * 60 // 2  # two hours


class StreamingTokenError(RuntimeError):
    """No token could be minted. Said out loud rather than returned as blank.

    A caller that receives an empty token opens a websocket that is refused,
    and the failure surfaces as "live text stopped" with no cause. This carries
    the cause up to something that can log it.
    """


class StreamingTokenService:
    """Mints AssemblyAI streaming tokens, and nothing else."""

    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None) -> None:
        self._settings = settings
        self._client = client

    @property
    def configured(self) -> bool:
        return bool(self._settings.assemblyai_api_key)

    async def mint(
        self,
        *,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
        session_seconds: int = DEFAULT_SESSION_SECONDS,
    ) -> tuple[str, int]:
        """Returns (token, ttl). Raises rather than returning an empty token."""
        if not self.configured:
            raise StreamingTokenError("ASSEMBLYAI_API_KEY is not set")

        ttl = max(MIN_TTL_SECONDS, min(MAX_TTL_SECONDS, int(ttl_seconds)))
        params = {
            "expires_in_seconds": str(ttl),
            "max_session_duration_seconds": str(max(60, int(session_seconds))),
        }
        headers = {"authorization": self._settings.assemblyai_api_key or ""}

        if self._client is not None:
            payload = await self._get(self._client, params, headers)
        else:
            async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=10.0)) as client:
                payload = await self._get(client, params, headers)

        token = str(payload.get("token") or "")
        if not token:
            raise StreamingTokenError("AssemblyAI returned no token")
        # The length, not the value. Enough to tell "minted" from "empty
        # string" in a log without the log becoming a credential.
        logger.info(
            "streaming.token.minted",
            extra={"ttl_seconds": ttl, "token_length": len(token)},
        )
        return token, int(payload.get("expires_in_seconds") or ttl)

    @staticmethod
    async def _get(client: httpx.AsyncClient, params: dict, headers: dict) -> dict:
        response = await client.get(TOKEN_URL, params=params, headers=headers)
        if response.status_code >= 400:
            # The provider's message names the offending parameter, and none of
            # its 4xx bodies echo the key back.
            raise StreamingTokenError(
                f"AssemblyAI token request failed ({response.status_code}): "
                f"{response.text[:200]}"
            )
        return response.json() or {}
