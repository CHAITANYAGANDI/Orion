"""Non-audio meeting sources: YouTube links and PDF documents.

The original path assumes the user already holds a recording. Two cheap sources
cover most of what people actually want summarised without one: a YouTube URL
(conference talks, webinars, recorded calls) and a PDF (minutes somebody else
typed up, a transcript exported from another tool).

Both converge on the existing pipeline, but they enter it at different points.
A YouTube link yields audio bytes and transcribes normally. A PDF is *already*
text, so it skips transcription altogether — there is nothing to transcribe and
no timeline to segment against, which is why documents have no audio player and
no transcript deep-links.

Only YouTube hosts are accepted even though yt-dlp supports well over a thousand
sites. The URL arrives from the user and is fetched by the worker, so an open
extractor is a server-side request forgery primitive; an allowlist keeps the
blast radius to one domain.
"""

from __future__ import annotations

import logging
import os
import re
import tempfile
from dataclasses import dataclass
from urllib.parse import urlparse

from app.config import Settings

logger = logging.getLogger("ai-service.ingest")

# Hosts whose URLs we are willing to hand to yt-dlp.
_YOUTUBE_HOSTS = frozenset({
    "youtube.com", "www.youtube.com", "m.youtube.com",
    "music.youtube.com", "youtu.be", "www.youtu.be",
})

# Paths that carry a watchable video on those hosts.
_YOUTUBE_PATH = re.compile(r"^/(watch|shorts/|live/|embed/|v/|[\w-]{11}$)")


@dataclass(frozen=True)
class IngestedSource:
    """What a non-audio source resolved to.

    Exactly one of `audio` / `text` is set: `audio` still needs transcribing,
    `text` is ready for analysis as-is.
    """

    filename: str
    audio: bytes | None = None
    text: str | None = None
    title: str | None = None
    duration_seconds: int | None = None

    @property
    def is_text(self) -> bool:
        return self.text is not None


class IngestError(RuntimeError):
    """A source could not be fetched or read. Message is user-facing."""


# --------------------------------------------------------------------------- #
# YouTube
# --------------------------------------------------------------------------- #

def is_youtube_url(url: str) -> bool:
    """True when `url` points at a YouTube video we are willing to fetch."""
    try:
        parsed = urlparse(url.strip())
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    if parsed.hostname is None or parsed.hostname.lower() not in _YOUTUBE_HOSTS:
        return False
    # youtu.be/<id> carries the id in the path; youtube.com/watch?v=<id> in the query.
    if parsed.hostname.lower().endswith("youtu.be"):
        return len(parsed.path.strip("/")) > 0
    return bool(_YOUTUBE_PATH.match(parsed.path))


def _download_youtube_sync(url: str, settings: Settings) -> IngestedSource:
    """Blocking yt-dlp download. Runs in a worker thread."""
    import yt_dlp

    with tempfile.TemporaryDirectory(prefix="recallix-yt-") as tmp:
        # `bestaudio` avoids any post-processing, which keeps ffmpeg off the
        # image — Whisper accepts the m4a/webm containers YouTube serves.
        options = {
            "format": "bestaudio/best",
            "outtmpl": os.path.join(tmp, "%(id)s.%(ext)s"),
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "noplaylist": True,
            "max_filesize": settings.youtube_max_bytes,
            "socket_timeout": settings.download_timeout_seconds,
            "retries": 2,
        }
        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                info = ydl.extract_info(url, download=True)
                path = ydl.prepare_filename(info)
        except Exception as exc:  # noqa: BLE001 — yt-dlp raises a wide range.
            raise IngestError(f"Could not download that YouTube video: {exc}") from exc

        duration = info.get("duration")
        if duration and duration > settings.youtube_max_duration_seconds:
            raise IngestError(
                f"That video is {int(duration) // 60} minutes long; the limit is "
                f"{settings.youtube_max_duration_seconds // 60}."
            )
        if not os.path.exists(path):
            # yt-dlp skips silently when max_filesize trips, leaving no file.
            raise IngestError(
                "That video's audio exceeds the size limit "
                f"({settings.youtube_max_bytes // (1024 * 1024)} MB)."
            )

        with open(path, "rb") as fh:
            audio = fh.read()

    logger.info("Downloaded %.1f MB of audio from YouTube.", len(audio) / 1_048_576)
    return IngestedSource(
        filename=os.path.basename(path),
        audio=audio,
        title=info.get("title"),
        duration_seconds=int(duration) if duration else None,
    )


async def fetch_youtube(url: str, settings: Settings) -> IngestedSource:
    """Download a YouTube video's audio track."""
    if not is_youtube_url(url):
        raise IngestError("Only YouTube links are supported.")
    import anyio

    return await anyio.to_thread.run_sync(_download_youtube_sync, url, settings)


# --------------------------------------------------------------------------- #
# PDF
# --------------------------------------------------------------------------- #

def extract_pdf_text(data: bytes, settings: Settings, filename: str = "document.pdf") -> IngestedSource:
    """Pull the text layer out of a PDF.

    Scanned PDFs have no text layer and yield nothing; that is reported rather
    than passed on, because an empty transcript would otherwise reach the LLM
    and produce a confidently invented summary.
    """
    from pypdf import PdfReader
    from io import BytesIO

    try:
        reader = PdfReader(BytesIO(data))
        pages = [page.extract_text() or "" for page in reader.pages]
    except Exception as exc:  # noqa: BLE001 — malformed PDFs raise widely.
        raise IngestError(f"Could not read that PDF: {exc}") from exc

    text = "\n\n".join(p.strip() for p in pages if p.strip()).strip()
    if not text:
        raise IngestError(
            "That PDF has no selectable text — it is probably a scan. "
            "Recallix does not run OCR."
        )

    truncated = text[: settings.document_max_chars]
    if len(text) > settings.document_max_chars:
        logger.warning(
            "PDF text truncated from %d to %d chars.", len(text), settings.document_max_chars
        )

    logger.info("Extracted %d chars from %d PDF pages.", len(truncated), len(pages))
    return IngestedSource(filename=filename, text=truncated, title=_title_from_pdf(reader, filename))


def _title_from_pdf(reader, filename: str) -> str | None:
    """Prefer the PDF's own title metadata over its filename."""
    try:
        title = (reader.metadata or {}).get("/Title")
    except Exception:  # noqa: BLE001 — metadata is frequently malformed.
        return None
    if isinstance(title, str) and title.strip():
        return title.strip()
    return os.path.splitext(filename)[0] or None
