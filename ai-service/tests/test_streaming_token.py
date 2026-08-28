"""The credential that reaches a browser, and everything it must not be.

Live transcription streams microphone audio from the tab straight to
AssemblyAI. Something has to authenticate that socket, and the one thing it
must never be is `ASSEMBLYAI_API_KEY` — a key in a bundle is a key in every
user's devtools, valid for the whole account, until somebody notices.
"""

from __future__ import annotations

import httpx
import pytest

from app.config import Settings
from app.streaming import (
    MAX_TTL_SECONDS,
    TOKEN_URL,
    StreamingTokenError,
    StreamingTokenService,
)

KEY = "secret-assemblyai-key"


def _service(handler, **overrides) -> StreamingTokenService:
    settings = Settings(assemblyai_api_key=KEY, **overrides)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return StreamingTokenService(settings, client=client)


def _ok(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"token": "tmp-token", "expires_in_seconds": 45})


@pytest.mark.asyncio
async def test_a_token_is_minted_from_the_key_and_the_key_stays_here():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _ok(request)

    token, ttl = await _service(handler).mint()

    assert token == "tmp-token"
    assert ttl == 45
    # The key authenticates the mint and goes no further than this process.
    assert seen[0].headers["authorization"] == KEY
    assert str(seen[0].url).startswith(TOKEN_URL)


@pytest.mark.asyncio
async def test_the_token_is_short_lived_by_default():
    """Short enough that one copied out of a network tab is expired before it
    can be pasted anywhere."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _ok(request)

    await _service(handler).mint()
    requested = int(dict(seen[0].url.params)["expires_in_seconds"])
    assert 0 < requested <= 60


@pytest.mark.asyncio
@pytest.mark.parametrize("asked,expected_max", [(0, 1), (99_999, MAX_TTL_SECONDS)])
async def test_a_ttl_outside_the_providers_range_is_clamped_not_rejected(asked, expected_max):
    """The provider answers 422 outside 1..600. Clamping here turns a failed
    meeting into a shorter-lived token, which nobody notices."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _ok(request)

    await _service(handler).mint(ttl_seconds=asked)
    requested = int(dict(seen[0].url.params)["expires_in_seconds"])
    assert 1 <= requested <= MAX_TTL_SECONDS


@pytest.mark.asyncio
async def test_a_missing_key_is_said_out_loud_rather_than_returned_as_blank():
    """A caller handed an empty token opens a websocket that is refused, and the
    user is told "live text stopped" with nothing anywhere saying why."""
    service = StreamingTokenService(Settings(assemblyai_api_key=None))
    assert service.configured is False
    with pytest.raises(StreamingTokenError):
        await service.mint()


@pytest.mark.asyncio
async def test_a_provider_error_is_raised_and_does_not_leak_the_key():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="Invalid API key supplied")

    with pytest.raises(StreamingTokenError) as raised:
        await _service(handler).mint()

    assert KEY not in str(raised.value)


@pytest.mark.asyncio
async def test_an_empty_token_from_the_provider_is_an_error_not_a_success():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"expires_in_seconds": 45})

    with pytest.raises(StreamingTokenError):
        await _service(handler).mint()


@pytest.mark.asyncio
async def test_nothing_about_the_token_is_logged(caplog):
    """Not the token, and not the key. A token written into a log aggregator
    outlives the seconds it was supposed to exist for."""
    import logging

    caplog.set_level(logging.DEBUG)
    await _service(_ok).mint()

    logged = " ".join(record.getMessage() for record in caplog.records)
    assert "tmp-token" not in logged
    assert KEY not in logged


@pytest.mark.asyncio
async def test_the_session_length_is_bounded_so_a_runaway_tab_cannot_hold_one_open():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _ok(request)

    await _service(handler).mint()
    params = dict(seen[0].url.params)
    assert "max_session_duration_seconds" in params
    assert int(params["max_session_duration_seconds"]) <= 10_800


# --- the endpoint ------------------------------------------------------------- #
def test_the_endpoint_says_503_rather_than_handing_back_an_empty_token(client):
    """The test settings carry no AssemblyAI key, which is the same state a
    deployment is in before anybody configures live transcription.

    A 200 with an empty string in it would send the browser off to open a
    websocket that is refused, and the only thing the user would see is "live
    text stopped" with no cause anywhere.
    """
    response = client.post("/ai/streaming-token")

    assert response.status_code == 503
    assert "token" not in response.json()
    assert KEY not in response.text


# --- the URL that is valid and unreachable ----------------------------------- #
def test_no_presigned_url_without_an_explicitly_public_endpoint():
    """The regression this exists for.

    `presigned_get_url` used to fall back to `s3_endpoint` when no public one
    was configured. That produced a perfectly valid signature over
    `http://minio:9000`, which AssemblyAI accepts and then cannot reach — and
    the meeting came back with no transcript at all.

    There is no safe default: the internal endpoint is wrong by definition and
    guessing a public one from it would be guessing. Unset means "send the
    bytes", which costs one transfer and cannot fail.
    """
    from app.config import Settings
    from app.storage import presigned_get_url

    internal_only = Settings(
        s3_endpoint="http://minio:9000",
        s3_public_endpoint="",
        s3_bucket="orion",
        s3_access_key="k",
        s3_secret_key="s",
    )
    assert presigned_get_url("meetings/u/m/rec.webm", internal_only) is None


def test_a_url_is_offered_once_a_reachable_endpoint_is_configured():
    from app.config import Settings
    from app.storage import presigned_get_url

    configured = Settings(
        s3_endpoint="http://minio:9000",
        s3_public_endpoint="https://storage.example.com",
        s3_bucket="orion",
        s3_access_key="k",
        s3_secret_key="s",
    )
    url = presigned_get_url("meetings/u/m/rec.webm", configured)

    assert url is not None
    assert url.startswith("https://storage.example.com")
    # Signed, not public: the bucket stays private.
    assert "X-Amz-Signature" in url
