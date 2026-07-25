"""Audio retrieval — HTTP(S) download plus an S3/MinIO helper.

The primary path downloads bytes from the `audioUrl` provided by Spring
(typically a presigned S3 URL). A boto3-based helper is available for fetching
by `objectKey` directly from MinIO/S3 when no URL is supplied.
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
