"""Audio retrieval — and, better, audio *not* retrieved.

Two ways to get a recording to a transcription provider:

1. Download the whole file here, then upload the whole file there. Two
   transfers of an hour of audio through a worker that does nothing with the
   bytes but pass them on.
2. Hand the provider a URL and let it fetch the file once, directly.

The second is what `presigned_get_url` exists for. The bucket stays private —
this mints a signature valid for minutes, for one object, for GET only — so
nothing is made public to save a hop. Where a signature cannot be produced
(no S3 credentials, a provider that will not fetch) the byte path is still
there and still correct.

The URL is a credential for one object and is never logged.
"""

from __future__ import annotations

import logging
import os
from urllib.parse import urlparse

import httpx

from app.config import Settings

logger = logging.getLogger("ai-service.storage")


def _filename_from_url(url: str) -> str:
    path = urlparse(url).path
    name = os.path.basename(path) or "audio"
    return name


async def download_from_url(url: str, settings: Settings) -> tuple[bytes, str]:
    """Download audio bytes from an HTTP(S) URL."""
    logger.info("Downloading audio from URL.")
    async with httpx.AsyncClient(timeout=settings.download_timeout_seconds, follow_redirects=True) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.content, _filename_from_url(url)


def download_from_s3(object_key: str, settings: Settings) -> tuple[bytes, str]:
    """Download audio bytes from S3/MinIO by object key (blocking boto3 call)."""
    import boto3  # imported lazily; only needed for the S3 path

    logger.info("Downloading audio from S3 object key.")
    client = boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name=settings.s3_region,
    )
    obj = client.get_object(Bucket=settings.s3_bucket, Key=object_key)
    body = obj["Body"].read()
    return body, os.path.basename(object_key) or "audio"


def presigned_get_url(
    object_key: str,
    settings: Settings,
    *,
    expires_seconds: int = 3600,
) -> str | None:
    """A short-lived GET URL for one object, or None if one cannot be made.

    None rather than an exception: this is an optimisation, and the caller has
    a working path without it. A deployment with no S3 credentials, or with a
    storage endpoint the provider cannot reach, should transcribe exactly as it
    did before rather than fail.

    <p><b>The lifetime is the whole point.</b> An hour is long enough for a
    provider to queue and fetch a long recording, and short enough that a URL
    recovered from anywhere afterwards opens nothing.

    <p><b>Requires `s3_public_endpoint` explicitly.</b> It used to fall back to
    `s3_endpoint`, and that fallback caused the exact failure the docstring
    above was warning about: a URL signed against `http://minio:9000` is
    perfectly valid, completely unreachable from outside the compose network,
    and AssemblyAI answers it with "could not connect to the host" after
    accepting the job. Three retries later the meeting had no transcript and
    nothing on screen said why.

    <p>There is no safe default here. The internal endpoint is wrong by
    definition, and guessing a public one from it would be guessing. Unset
    means "do not hand out URLs", which costs one extra file transfer and
    cannot fail.
    """
    if not object_key or not settings.s3_public_endpoint:
        return None
    try:
        import boto3
        from botocore.config import Config

        client = boto3.client(
            "s3",
            endpoint_url=settings.s3_public_endpoint,
            aws_access_key_id=settings.s3_access_key,
            aws_secret_access_key=settings.s3_secret_key,
            region_name=settings.s3_region,
            config=Config(signature_version="s3v4"),
        )
        return client.generate_presigned_url(
            "get_object",
            Params={"Bucket": settings.s3_bucket, "Key": object_key},
            ExpiresIn=max(60, int(expires_seconds)),
        )
    except Exception as exc:  # noqa: BLE001 — boto3 raises a wide range.
        logger.info("No presigned URL for %s (%s); falling back to bytes.", object_key, type(exc).__name__)
        return None


async def fetch_audio(
    settings: Settings,
    *,
    audio_url: str | None = None,
    object_key: str | None = None,
) -> tuple[bytes, str]:
    """Fetch audio via URL when available, else via S3 object key.

    Returns (b"", "audio") when neither is provided — the mock provider ignores
    the bytes, so keyless/urlless demos still work end to end.
    """
    if audio_url:
        return await download_from_url(audio_url, settings)
    if object_key and settings.s3_endpoint:
        import anyio

        return await anyio.to_thread.run_sync(download_from_s3, object_key, settings)
    logger.warning("No audioUrl or objectKey provided; returning empty audio bytes.")
    return b"", "audio"
