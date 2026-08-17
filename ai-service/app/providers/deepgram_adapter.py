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
        vocabulary: list[str] | None = None,
        language: str | None = None,
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

            boost = boost_params(vocabulary, self._settings.deepgram_model)
            if boost:
                # httpx repeats a list-valued param, which is exactly the wire
                # format Deepgram wants: ?keyterm=a&keyterm=b.
                params.update(boost)

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

# Deepgram accepts more, but every extra term is another word the model is
# biased toward: a list of everything boosts nothing. The backend caps a user's
# vocabulary well below this; the cap is repeated here because this adapter is
# also reachable from the HTTP endpoints, which do not go through that cap.
MAX_BOOST_TERMS = 100


def boost_params(vocabulary: list[str] | None, model: str) -> dict[str, Any]:
    """Map the user's vocabulary onto whichever boosting parameter the model takes.

    Deepgram renamed the feature between model generations, and the two are not
    interchangeable — `keywords` is silently ignored by nova-3, and `keyterm`
    is rejected by nova-2. Sending the wrong one is a boost that appears to
    work and does nothing, so the model decides which name is used.
    """
    if not vocabulary:
        return {}

    terms: list[str] = []
    seen: set[str] = set()
    for raw in vocabulary:
        # Deepgram splits on commas, so a term containing one would arrive as
        # two partial terms; dropping the comma keeps it a single phrase.
        # Whitespace is collapsed afterwards so "Smith, Jane" does not become a
        # term with a double space that matches nothing said out loud.
        term = " ".join(str(raw or "").replace(",", " ").split())
        if not term:
            continue
        key = term.lower()
        if key in seen:
            continue
        seen.add(key)
        terms.append(term)
        if len(terms) >= MAX_BOOST_TERMS:
            break

    if not terms:
        return {}

    # nova-3 and later take `keyterm`; earlier models take `keywords`.
    parameter = "keyterm" if _is_keyterm_model(model) else "keywords"
    logger.info("Sending %d vocabulary term(s) to Deepgram as %s.", len(terms), parameter)
    return {parameter: terms}


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
    segments = _segments_from_utterances(results.get("utterances"))
    if not segments:
        segments = _segments_from_words(alternative.get("words"))

    # Prefer text rebuilt from the segments: it carries the speaker turns and
    # the line breaks between them, which the flat `transcript` string does not.
    transcript = _join(segments) or str(alternative.get("transcript") or "").strip()

    speakers = {s.speaker for s in segments}
    logger.info(
        "Deepgram returned %d segment(s) across %d speaker(s), language=%s.",
        len(segments), len(speakers), language,
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


def _words_of(words: Any) -> list[Word]:
    """Per-word timings, which drive the highlight and click-to-seek.

    Deepgram nests these inside each utterance. Without them the UI has to
    spread an utterance's span evenly across its text, which runs ahead of the
    voice wherever the speaker pauses.
    """
    if not isinstance(words, list):
        return []
    out: list[Word] = []
    for word in words:
        if not isinstance(word, dict):
            continue
        text = str(word.get("punctuated_word") or word.get("word") or "").strip()
        if not text:
            continue
        out.append(Word(
            text=text,
            start=_as_float(word.get("start")),
            end=_as_float(word.get("end")),
        ))
    return out


def _segments_from_utterances(utterances: Any) -> list[Segment]:
    """Primary path: Deepgram has already grouped words into speaker turns."""
    if not isinstance(utterances, list):
        return []
    out: list[Segment] = []
    for utterance in utterances:
        if not isinstance(utterance, dict):
            continue
        text = str(utterance.get("transcript") or "").strip()
        if not text:
            continue
        out.append(Segment(
            start=_as_float(utterance.get("start")),
            end=_as_float(utterance.get("end")),
            speaker=speaker_label(utterance.get("speaker")),
            text=text,
            words=_words_of(utterance.get("words")),
        ))
    return out


def _segments_from_words(words: Any) -> list[Segment]:
    """Fallback: rebuild turns by grouping consecutive words per speaker.

    Only used when `utterances` is absent. A turn ends when the speaker changes,
    which is coarser than Deepgram's own segmentation — long monologues become
    one very long segment — but it beats returning nothing.
    """
    if not isinstance(words, list) or not words:
        return []

    out: list[Segment] = []
    current_speaker: Any = _MISSING
    buffer: list[Word] = []
    start = 0.0
    end = 0.0

    for word in words:
        if not isinstance(word, dict):
            continue
        # `punctuated_word` exists when smart formatting is on and is the
        # readable form; `word` is the raw token.
        text = str(word.get("punctuated_word") or word.get("word") or "").strip()
        if not text:
            continue
        speaker = word.get("speaker")

        if speaker != current_speaker and buffer:
            out.append(_turn(start, end, current_speaker, buffer))
            buffer = []

        if not buffer:
            start = _as_float(word.get("start"))
            current_speaker = speaker

        buffer.append(Word(
            text=text,
            start=_as_float(word.get("start")),
            end=_as_float(word.get("end")),
        ))
        end = _as_float(word.get("end"))

    if buffer:
        out.append(_turn(start, end, current_speaker, buffer))
    return out


def _turn(start: float, end: float, speaker: Any, words: list[Word]) -> Segment:
    return Segment(
        start=start,
        end=end,
        speaker=speaker_label(speaker),
        text=" ".join(w.text for w in words),
        words=list(words),
    )


class _Missing:
    """Sentinel: `None` is a real speaker value when diarization is off."""


_MISSING = _Missing()


def speaker_label(speaker: Any) -> str:
    """Deepgram's 0-based speaker index -> a label a human can rename.

    Returns "Speaker 1", "Speaker 2", … rather than "S1": the whole point of
    diarization is that the transcript reads like a conversation, and the
    existing rename feature turns these into real names.
    """
    if isinstance(speaker, bool) or not isinstance(speaker, int):
        return "Speaker 1"
    return f"Speaker {speaker + 1}"


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
