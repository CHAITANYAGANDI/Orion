"""Alternative meeting sources: YouTube links and PDF documents.

Two things matter here and neither is about happy paths. The URL allowlist is a
security boundary — the worker fetches whatever URL a user submits, so anything
that slips past `is_youtube_url` becomes a server-side request forgery. And a
PDF with no text layer must fail loudly rather than hand an empty string to the
LLM, which would answer with a confident invention.
"""

from __future__ import annotations

import pytest

from app.config import Settings
from app.ingest import IngestError, extract_pdf_text, is_youtube_url
from app.pipeline import Pipeline
from app.providers.mock_adapter import SCRIPTS, MockLlmAdapter, MockTranscriptionAdapter


@pytest.fixture
def settings() -> Settings:
    return Settings()


# --------------------------------------------------------------------------- #
# URL allowlist
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("url", [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch?v=dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/abc123",
    "https://www.youtube.com/live/abc123",
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
])
def test_youtube_urls_are_accepted(url):
    assert is_youtube_url(url) is True


@pytest.mark.parametrize("url", [
    # Other extractors yt-dlp supports — out of scope, so out of bounds.
    "https://vimeo.com/12345",
    "https://www.tiktok.com/@x/video/1",
    # Internal targets: the whole point of the allowlist.
    "http://localhost:8080/actuator/env",
    "http://127.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://minio:9000/recallix",
    # Non-HTTP schemes that would read the worker's own filesystem.
    "file:///etc/passwd",
    "ftp://youtube.com/x",
    # Lookalike hosts.
    "https://youtube.com.evil.test/watch?v=1",
    "https://notyoutube.com/watch?v=1",
    "https://evil.test/?x=youtube.com/watch",
    "",
    "not a url",
])
def test_non_youtube_urls_are_rejected(url):
    assert is_youtube_url(url) is False


def test_subdomain_suffix_does_not_slip_through():
    """`endswith` on the host would let this through; equality must not."""
    assert is_youtube_url("https://evil-youtube.com/watch?v=1") is False
    assert is_youtube_url("https://www.youtube.com.attacker.io/watch?v=1") is False


# --------------------------------------------------------------------------- #
# PDF extraction
# --------------------------------------------------------------------------- #

def _pdf(lines: list[str]) -> bytes:
    """Build a minimal but structurally valid PDF with a real text layer.

    Hand-assembled rather than mocked so the test exercises pypdf itself: the
    xref offsets are computed from the actual byte positions.
    """
    ops = " ".join(f"({line}) Tj T*" for line in lines)
    content = f"BT /F1 12 Tf 72 720 Td 14 TL {ops} ET".encode("latin-1")
    objects = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R"
        b"/Resources<</Font<</F1 5 0 R>>>>>>",
        b"<</Length " + str(len(content)).encode() + b">>stream\n" + content + b"\nendstream",
        b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    ]

    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"

    xref_at = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<</Size {len(objects) + 1}/Root 1 0 R>>\n"
        f"startxref\n{xref_at}\n%%EOF\n"
    ).encode()
    return bytes(out)


def test_pdf_text_is_extracted(settings):
    source = extract_pdf_text(_pdf(["Ana will ship the API by Friday."]), settings, "minutes.pdf")
    assert "Ana will ship the API by Friday." in (source.text or "")
    assert source.is_text is True
    assert source.audio is None


def test_scanned_pdf_is_rejected_rather_than_summarised(settings):
    """No text layer must fail — an empty transcript produces a fabricated brief."""
    from pypdf import PdfWriter
    from io import BytesIO

    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    buffer = BytesIO()
    writer.write(buffer)

    with pytest.raises(IngestError, match="no selectable text"):
        extract_pdf_text(buffer.getvalue(), settings, "scan.pdf")


def test_corrupt_pdf_reports_rather_than_crashes(settings):
    with pytest.raises(IngestError):
        extract_pdf_text(b"this is definitely not a pdf", settings, "junk.pdf")


def test_long_pdf_is_truncated_to_the_analysis_budget(settings):
    settings = Settings(document_max_chars=50)
    source = extract_pdf_text(_pdf(["word " * 200], ), settings, "long.pdf")
    assert len(source.text or "") == 50


# --------------------------------------------------------------------------- #
# Document pipeline
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_document_pipeline_skips_transcription():
    """A PDF has no audio, so the transcription port must never be touched."""

    class ExplodingTranscriber(MockTranscriptionAdapter):
        async def transcribe(self, audio, filename):  # noqa: ANN001
            raise AssertionError("a document must not be transcribed")

    pipeline = Pipeline(ExplodingTranscriber(), MockLlmAdapter())
    result = await pipeline.process_document("mtg_doc", "We agreed to ship on Friday.")

    assert result.transcript == "We agreed to ship on Friday."
    # No audio means no timeline, so there is nothing to seek to.
    assert result.segments == []
    assert result.short_summary


@pytest.mark.asyncio
async def test_document_pipeline_still_extracts_everything():
    pipeline = Pipeline(MockTranscriptionAdapter(), MockLlmAdapter())
    # Feed a known script's transcript so the mock extractors have something to
    # find — exactly what a PDF of typed-up minutes would contain.
    result = await pipeline.process_document("mtg_doc", SCRIPTS[0].transcript)

    assert result.action_items, "documents should still yield action items"
    assert result.decisions, "documents should still yield decisions"


@pytest.mark.asyncio
async def test_document_pipeline_reports_progress():
    seen: list[tuple[str, int]] = []

    async def hook(topic, event):  # noqa: ANN001
        seen.append((event.status, event.progress))

    pipeline = Pipeline(MockTranscriptionAdapter(), MockLlmAdapter())
    await pipeline.process_document("mtg_doc", "Short text.", progress_hook=hook)

    statuses = [s for s, _ in seen]
    assert "SUMMARIZING" in statuses
    # Progress must never go backwards, or the frontend bar jumps around.
    assert [p for _, p in seen] == sorted(p for _, p in seen)
