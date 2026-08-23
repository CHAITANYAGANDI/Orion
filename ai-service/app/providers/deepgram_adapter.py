"""Deepgram speech-to-text with speaker diarization.

Whisper returns one undifferentiated block of text: every speaker is labelled
`S1`, so a transcript reads as though one person talked for an hour. Deepgram
separates voices, which is the difference between a transcript you can read and
one you have to decode.

Deepgram is asked for *utterances* rather than raw words. It has already done
the work of grouping consecutive words by speaker and breaking on natural
pauses, and its grouping is better than anything reconstructed downstream. Word
grouping is implemented anyway as a fallback, because `utterances` is a request
parameter someone can turn off and an empty transcript is a bad way to find out.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable, TypeVar

import httpx

from app.config import Settings
from app.diarization import (
    CanonicalSpeakers,
    SpeakerIdentity,
    join_words,
    raw_token,
    split_by_speaker,
)
from app.diarization import SpokenWord as DiarizedWord
from app.providers.ports import TranscriptionPort
from app.schemas import Segment, TranscriptResponse, Word

logger = logging.getLogger("ai-service.deepgram")

DEEPGRAM_URL = "https://api.deepgram.com/v1/listen"

T = TypeVar("T")


async def _with_retries(
    op: Callable[[], Awaitable[T]], *, attempts: int, fallback: T, label: str
) -> T:
    """Retry on transient failure, then degrade rather than fail the meeting.

    A meeting that produced no transcript is recoverable — the user can hit
    reprocess. One that crashed the worker is not.
    """
    delay = 1.0
    for attempt in range(1, attempts + 1):
        try:
            return await op()
        except Exception as exc:  # noqa: BLE001 — httpx raises a wide range.
            logger.warning("Deepgram %s attempt %d/%d failed: %s", label, attempt, attempts, exc)
            if attempt == attempts:
                logger.error("Deepgram %s giving up after %d attempts.", label, attempts)
                return fallback
            await asyncio.sleep(delay)
            delay *= 2
    return fallback


class DeepgramTranscriptionAdapter(TranscriptionPort):
    """Transcription via Deepgram's pre-recorded API, with diarization on."""

    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None) -> None:
        self._settings = settings
        self._client = client
        if not settings.deepgram_api_key:
            # Loud, because the factory only picks this adapter when explicitly
            # asked for it — a missing key here is a misconfiguration, not a
            # default.
            logger.error("Deepgram selected but DEEPGRAM_API_KEY is empty; transcription will fail.")

    async def transcribe(
        self,
        audio: bytes,
        filename: str,
        language: str | None = None,
        *,
        request=None,  # noqa: ARG002 - accepted for the port, unused here.
    ) -> TranscriptResponse:
        async def _op() -> TranscriptResponse:
            params: dict[str, Any] = {
                "model": self._settings.deepgram_model,
                "diarize": "true",
                "utterances": "true",
                "punctuate": "true",
                # Turns "one two three" into "123" and formats dates/times, which
                # matters because action items are extracted from this text.
                "smart_format": "true",
            }
            chosen = (language or "").strip() or self._settings.deepgram_language
            if chosen:
                params["language"] = chosen
            else:
                params["detect_language"] = "true"

            headers = {
                "Authorization": f"Token {self._settings.deepgram_api_key}",
                "Content-Type": _content_type(filename),
            }

            if self._client is not None:
                response = await self._client.post(
                    DEEPGRAM_URL, params=params, headers=headers, content=audio
                )
            else:
                timeout = httpx.Timeout(self._settings.deepgram_timeout_seconds, connect=15.0)
                async with httpx.AsyncClient(timeout=timeout) as client:
                    response = await client.post(
                        DEEPGRAM_URL, params=params, headers=headers, content=audio
                    )

            response.raise_for_status()
            return parse_response(response.json())

        return await _with_retries(
            _op,
            attempts=self._settings.deepgram_max_retries + 1,
            fallback=TranscriptResponse(transcript="", language="en", segments=[]),
            label="transcribe",
        )


# --------------------------------------------------------------------------- #
# Request shaping — pure, so it can be tested without a network or a key.
# --------------------------------------------------------------------------- #

# Deepgram's boosting parameters — `keyterm` on nova-3 and later, `keywords`
# before it — were filled from the account's custom vocabulary. That feature is
# gone and nothing else produced terms, so no boosting field is sent. The
# distinction is kept here because it is a fact about the provider that a
# future caller would have to rediscover, and getting it wrong is invisible:
# `keywords` is silently ignored by nova-3, and `keyterm` is rejected by nova-2.


def _is_keyterm_model(model: str) -> bool:
    name = (model or "").strip().lower()
    # Unknown/custom model names default to keyterm: it is the current
    # parameter, so a model added after this code was written is more likely to
    # want it than the legacy one.
    return not name.startswith(("nova-2", "nova-1", "base", "enhanced", "whisper"))


# --------------------------------------------------------------------------- #
# Response mapping — pure, so it can be tested without a network or a key.
# --------------------------------------------------------------------------- #

def parse_response(payload: dict[str, Any]) -> TranscriptResponse:
    """Map Deepgram's response onto the shape the rest of the pipeline expects."""
    results = payload.get("results") or {}
    channels = results.get("channels") or []
    channel = channels[0] if channels else {}
    alternatives = channel.get("alternatives") or []
    alternative = alternatives[0] if alternatives else {}

    language = _language_of(channel, payload)
    # One map per response, fed in chronological order: Deepgram numbers its
    # speaker clusters from zero and those numbers are cluster ids, not
    # positions in the meeting. Whichever voice speaks first is Speaker 1.
    speakers = CanonicalSpeakers()
    segments = _segments_from_utterances(results.get("utterances"), speakers)
    if not segments:
        segments = _segments_from_words(alternative.get("words"), speakers)

    # Prefer text rebuilt from the segments: it carries the speaker turns and
    # the line breaks between them, which the flat `transcript` string does not.
    transcript = _join(segments) or str(alternative.get("transcript") or "").strip()

    logger.info(
        "Deepgram returned %d segment(s) across %d speaker(s), language=%s.",
        len(segments), speakers.count, language,
    )
    return TranscriptResponse(transcript=transcript, language=language, segments=segments)


def _language_of(channel: dict[str, Any], payload: dict[str, Any]) -> str:
    detected = channel.get("detected_language")
    if isinstance(detected, str) and detected.strip():
        # Deepgram may return a locale ("en-US"); the rest of the app stores a
        # bare ISO-639-1 code.
        return detected.strip().lower()[:2]
    model_info = (payload.get("metadata") or {}).get("model_info") or {}
    language = model_info.get("language")
    if isinstance(language, str) and language.strip():
        return language.strip().lower()[:2]
    return "en"


def _words_of(words: Any, *, fallback: str | None = None) -> list[DiarizedWord]:
    """Per-word timings **and attribution**, which drive the highlight and the split.

    Deepgram nests these inside each utterance. Without them the UI has to
    spread an utterance's span evenly across its text, which runs ahead of the
    voice wherever the speaker pauses — and without the per-word speaker, a
    change of speaker inside an utterance has nowhere to be recorded.

    `fallback` is the parent utterance's label, for words Deepgram left
    unattributed inside an otherwise attributed turn.
    """
    if not isinstance(words, list):
        return []
    out: list[DiarizedWord] = []
    for word in words:
        if not isinstance(word, dict):
            continue
        text = str(word.get("punctuated_word") or word.get("word") or "").strip()
        if not text:
            continue
        out.append(DiarizedWord(
            text=text,
            start=_as_float(word.get("start")),
            end=_as_float(word.get("end")),
            speaker=raw_token(word.get("speaker")) or fallback,
        ))
    return out


def _segments_from_utterances(
    utterances: Any, speakers: CanonicalSpeakers
) -> list[Segment]:
    """Primary path: Deepgram has already grouped words into speaker turns.

    An utterance whose words all agree is emitted intact, keeping Deepgram's
    own punctuation. Where the words disagree with the parent label, the words
    win — that is a speaker change inside an utterance, and it is exactly the
    short interjection that used to be absorbed into whichever turn it landed
    in the middle of.
    """
    if not isinstance(utterances, list):
        return []
    out: list[Segment] = []
    for utterance in utterances:
        if not isinstance(utterance, dict):
            continue
        text = str(utterance.get("transcript") or "").strip()
        if not text:
            continue

        parent = raw_token(utterance.get("speaker"))
        words = _words_of(utterance.get("words"), fallback=parent)

        if not words:
            out.append(_segment(
                start=_as_float(utterance.get("start")),
                end=_as_float(utterance.get("end")),
                identity=speakers.for_token(parent),
                text=text,
                words=[],
            ))
            continue

        runs = split_by_speaker(words, speakers)
        if len(runs) == 1:
            out.append(_segment(
                start=_as_float(utterance.get("start")),
                end=_as_float(utterance.get("end")),
                identity=runs[0].identity,
                text=text,
                words=runs[0].words,
            ))
            continue

        for run in runs:
            out.append(_segment(
                start=run.start,
                end=run.end,
                identity=run.identity,
                text=join_words(run.words, capitalise=run.split),
                words=run.words,
            ))
    return out


def _segment(
    *,
    start: float,
    end: float,
    identity: SpeakerIdentity,
    text: str,
    words: list[DiarizedWord],
) -> Segment:
    """Assemble a canonical segment, stamping identity onto every word."""
    return Segment(
        start=start,
        end=end,
        speaker=identity.label,
        speaker_key=identity.key,
        speaker_raw=identity.raw,
        speaker_status=identity.status,
        text=text,
        words=[
            Word(
                text=word.text,
                start=word.start,
                end=word.end,
                speaker=identity.label,
                speaker_raw=word.speaker or identity.raw,
            )
            for word in words
        ],
    )


def _segments_from_words(words: Any, speakers: CanonicalSpeakers) -> list[Segment]:
    """Fallback: rebuild turns by grouping consecutive words per speaker.

    Only used when `utterances` is absent. A turn ends when the speaker
    changes, which is coarser than Deepgram's own segmentation — long
    monologues become one very long segment — but it beats returning nothing.
    """
    if not isinstance(words, list) or not words:
        return []

    parsed = _words_of(words)
    if not parsed:
        return []

    return [
        _segment(
            start=run.start,
            end=run.end,
            identity=run.identity,
            # No provider-formatted utterance text on this path; every run is
            # rebuilt and every run begins a turn.
            text=join_words(run.words, capitalise=True),
            words=run.words,
        )
        for run in split_by_speaker(parsed, speakers)
    ]


def _join(segments: list[Segment]) -> str:
    """Render turns as "Speaker 1: ..." lines.

    The speaker prefix is deliberate: the LLM reads this text, and attributing
    an action item to the right person needs the attribution to be visible.
    """
    return "\n".join(f"{s.speaker}: {s.text}" for s in segments).strip()


def _as_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


# Extension -> MIME type. Deepgram sniffs the container itself, so this only
# has to be close enough not to mislead it; `application/octet-stream` is the
# documented way to say "work it out".
_CONTENT_TYPES = {
    "mp3": "audio/mpeg", "mpeg": "audio/mpeg", "m4a": "audio/mp4",
    "mp4": "video/mp4", "aac": "audio/aac", "wav": "audio/wav",
    "flac": "audio/flac", "ogg": "audio/ogg", "opus": "audio/ogg",
    "webm": "audio/webm", "mov": "video/quicktime", "amr": "audio/amr",
}


def _content_type(filename: str) -> str:
    if not filename or "." not in filename:
        return "application/octet-stream"
    extension = filename.rsplit(".", 1)[-1].strip().lower()
    return _CONTENT_TYPES.get(extension, "application/octet-stream")
