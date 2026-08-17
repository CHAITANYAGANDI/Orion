"""AssemblyAI speech-to-text with speaker diarization.

Chosen over Deepgram Nova-3 for speaker-attributed accuracy: what a meeting app
gets wrong is not usually the words, it is which person said them, and cpWER
(the right speaker label on the right words) is the number that tracks that.

Two differences from Deepgram are load-bearing and easy to get silently wrong:

* **Timestamps are milliseconds here, seconds in Deepgram.** Everything
  downstream — the audio player, word highlighting, citation deep-links,
  `_duration_of` — reads `Segment.start/end` as seconds. A missed conversion
  does not raise; it makes a 40-minute meeting look 11 hours long.
* **Speakers are letters ("A", "B"), not 0-based indices.** They are mapped to
  the same "Speaker 1" labels Deepgram produced so existing transcripts, the
  rename feature and the per-speaker colours all keep working.

The API is asynchronous: upload the bytes, submit a job, then poll. That is
three round trips where Deepgram had one, but it is also why AssemblyAI has no
25MB ceiling — the whole recording is diarized in a single pass, so speaker
identity holds across a long meeting instead of being renumbered per chunk.

`speech_models` is sent as a priority list rather than a single name. The API
retires model names (it rejected `universal-3-pro` outright in favour of
`universal-3-5-pro`), and a deprecation returns a 400 rather than degrading, so
the fallback entry is what keeps a job running when the first name goes away.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from app.config import Settings
from app.providers.ports import TranscriptionPort
from app.schemas import Segment, TranscriptResponse, Word

logger = logging.getLogger("ai-service.assemblyai")

BASE_URL = "https://api.assemblyai.com/v2"
UPLOAD_URL = f"{BASE_URL}/upload"
TRANSCRIPT_URL = f"{BASE_URL}/transcript"

_EMPTY = TranscriptResponse(transcript="", language="en", segments=[])

# AssemblyAI documents a 1000-term ceiling for word_boost. The lower cap here
# matches the Deepgram adapter and reflects the same trade: every extra term is
# another word the model is biased toward, so an unbounded list boosts nothing.
MAX_BOOST_TERMS = 100


class AssemblyAiTranscriptionAdapter(TranscriptionPort):
    """Transcription via AssemblyAI's async API, with diarization on."""

    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None) -> None:
        self._settings = settings
        self._client = client
        if not settings.assemblyai_api_key:
            # Loud: the factory only picks this adapter when explicitly asked
            # for it, so a missing key is a misconfiguration, not a default.
            logger.error(
                "AssemblyAI selected but ASSEMBLYAI_API_KEY is empty; transcription will fail."
            )

    # --- the port ----------------------------------------------------------- #
    async def transcribe(
        self,
        audio: bytes,
        filename: str,
        vocabulary: list[str] | None = None,
        language: str | None = None,
    ) -> TranscriptResponse:
        attempts = self._settings.assemblyai_max_retries + 1
        delay = 1.0
        for attempt in range(1, attempts + 1):
            try:
                return await self._run(audio, vocabulary, language)
            except Exception as exc:  # noqa: BLE001 — httpx raises a wide range.
                logger.warning(
                    "AssemblyAI transcribe attempt %d/%d failed: %s", attempt, attempts, exc
                )
                if attempt == attempts:
                    # Degrade rather than fail the meeting: a meeting with no
                    # transcript is recoverable with reprocess, a crashed
                    # worker is not.
                    logger.error("AssemblyAI giving up after %d attempts.", attempts)
                    return _EMPTY
                await asyncio.sleep(delay)
                delay *= 2
        return _EMPTY

    async def _run(
        self,
        audio: bytes,
        vocabulary: list[str] | None = None,
        language: str | None = None,
    ) -> TranscriptResponse:
        if self._client is not None:
            return await self._transcribe_with(self._client, audio, vocabulary, language)
        timeout = httpx.Timeout(self._settings.assemblyai_timeout_seconds, connect=15.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            return await self._transcribe_with(client, audio, vocabulary, language)

    async def _transcribe_with(
        self,
        client: httpx.AsyncClient,
        audio: bytes,
        vocabulary: list[str] | None = None,
        language: str | None = None,
    ) -> TranscriptResponse:
        upload_url = await self._upload(client, audio)
        job_id = await self._submit(client, upload_url, vocabulary, language)
        payload = await self._poll(client, job_id)
        return parse_response(payload)

    # --- the three round trips ---------------------------------------------- #
    def _headers(self) -> dict[str, str]:
        return {"authorization": self._settings.assemblyai_api_key or ""}

    async def _upload(self, client: httpx.AsyncClient, audio: bytes) -> str:
        response = await client.post(UPLOAD_URL, headers=self._headers(), content=audio)
        response.raise_for_status()
        upload_url = (response.json() or {}).get("upload_url")
        if not upload_url:
            raise RuntimeError("AssemblyAI upload returned no upload_url")
        logger.info("Uploaded %.1f MB to AssemblyAI.", len(audio) / 1_048_576)
        return str(upload_url)

    async def _submit(
        self,
        client: httpx.AsyncClient,
        upload_url: str,
        vocabulary: list[str] | None = None,
        language: str | None = None,
    ) -> str:
        settings = self._settings
        # A priority list, not a single model: if the detected language is not
        # supported by the first, AssemblyAI routes to the next rather than
        # failing the job. That is why the fallback is configurable and not a
        # hardcoded second call.
        models = [settings.assemblyai_model]
        if settings.assemblyai_fallback_model:
            models.append(settings.assemblyai_fallback_model)

        body: dict[str, Any] = {
            "audio_url": upload_url,
            "speech_models": models,
            # Turn-level and word-level speaker attribution. The whole reason
            # this adapter exists.
            "speaker_labels": True,
            "punctuate": True,
            # Numbers and dates in written form, which matters because action
            # items are extracted from this text.
            "format_text": True,
        }
        chosen = language_choice(language, settings.assemblyai_language)
        if chosen:
            body["language_code"] = chosen
        else:
            body["language_detection"] = True

        boost = word_boost(vocabulary)
        if boost:
            body["word_boost"] = boost
            # "high" because the terms are ones the user explicitly told us they
            # say — the default weighting is tuned for speculative hints.
            body["boost_param"] = "high"

        response = await client.post(TRANSCRIPT_URL, headers=self._headers(), json=body)
        response.raise_for_status()
        job_id = (response.json() or {}).get("id")
        if not job_id:
            raise RuntimeError("AssemblyAI submit returned no transcript id")
        return str(job_id)

    async def _poll(self, client: httpx.AsyncClient, job_id: str) -> dict[str, Any]:
        """Wait for the job, bounded by the configured timeout.

        The deadline is on wall-clock rather than a poll count so that changing
        the interval cannot quietly change how long a meeting is allowed to
        take.
        """
        url = f"{TRANSCRIPT_URL}/{job_id}"
        interval = self._settings.assemblyai_poll_interval_seconds
        deadline = asyncio.get_running_loop().time() + self._settings.assemblyai_timeout_seconds

        while True:
            response = await client.get(url, headers=self._headers())
            response.raise_for_status()
            payload = response.json() or {}
            status = str(payload.get("status") or "")

            if status == "completed":
                return payload
            if status == "error":
                raise RuntimeError(f"AssemblyAI transcription failed: {payload.get('error')}")
            if asyncio.get_running_loop().time() >= deadline:
                raise TimeoutError(
                    f"AssemblyAI job {job_id} still {status or 'unknown'} after "
                    f"{self._settings.assemblyai_timeout_seconds:.0f}s"
                )
            await asyncio.sleep(interval)


# --------------------------------------------------------------------------- #
# Response mapping — pure, so it can be tested without a network or a key.
# --------------------------------------------------------------------------- #

def language_choice(requested: str | None, configured: str | None) -> str | None:
    """Which language to transcribe in, or None to let the provider detect.

    The account setting wins over the deployment-wide env var: the env var is
    what this Recallix defaults to, and the account setting is somebody saying
    they know better about their own meetings. Neither means detect, which is
    right for a multilingual user and wrong for exactly the recordings detection
    gets wrong — short ones, noisy first minutes, and meetings held in two
    languages. A wrong detection is not a cosmetic label: the words come back in
    a language nobody spoke and nothing downstream repairs that.
    """
    return (requested or "").strip() or (configured or "").strip() or None


def word_boost(vocabulary: list[str] | None) -> list[str]:
    """The user's vocabulary as AssemblyAI's `word_boost` list.

    AssemblyAI documents a 1000-term ceiling and treats each entry as a word or
    short phrase. The list is de-duplicated case-insensitively because a term
    appearing twice weights it twice, which is not what the user asked for by
    adding it once.
    """
    if not vocabulary:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for raw in vocabulary:
        term = str(raw or "").strip()
        if not term:
            continue
        key = term.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(term)
        if len(out) >= MAX_BOOST_TERMS:
            break
    return out


def parse_response(payload: dict[str, Any]) -> TranscriptResponse:
    """Map AssemblyAI's response onto the shape the rest of the pipeline expects."""
    language = _language_of(payload)
    segments = _segments_from_utterances(payload.get("utterances"))
    if not segments:
        segments = _segments_from_words(payload.get("words"))

    # Prefer text rebuilt from the segments: it carries the speaker turns and
    # the line breaks between them, which the flat `text` string does not.
    transcript = _join(segments) or str(payload.get("text") or "").strip()

    speakers = {s.speaker for s in segments}
    logger.info(
        "AssemblyAI returned %d segment(s) across %d speaker(s), language=%s.",
        len(segments), len(speakers), language,
    )
    return TranscriptResponse(transcript=transcript, language=language, segments=segments)


def _language_of(payload: dict[str, Any]) -> str:
    """ISO-639-1, stripped of any locale suffix.

    AssemblyAI returns codes like "en_us"; the rest of the app stores a bare
    two-letter code, and `en_us` reaching the UI would fail every language
    lookup silently.
    """
    code = payload.get("language_code")
    if isinstance(code, str) and code.strip():
        return code.strip().lower().replace("-", "_").split("_")[0][:2]
    return "en"


def _segments_from_utterances(utterances: Any) -> list[Segment]:
    """Primary path: AssemblyAI has already grouped words into speaker turns."""
    if not isinstance(utterances, list):
        return []
    out: list[Segment] = []
    for utterance in utterances:
        if not isinstance(utterance, dict):
            continue
        text = str(utterance.get("text") or "").strip()
        if not text:
            continue
        out.append(Segment(
            start=_seconds(utterance.get("start")),
            end=_seconds(utterance.get("end")),
            speaker=speaker_label(utterance.get("speaker")),
            text=text,
            words=_words_of(utterance.get("words")),
        ))
    return out


def _words_of(words: Any) -> list[Word]:
    """Per-word timings, which drive the highlight and click-to-seek.

    AssemblyAI nests these inside each utterance. They are the reason this
    adapter can highlight accurately where the previous one had to estimate:
    an utterance here can run half a minute, and an even-rate guess over that
    span drifts far enough to point at the wrong sentence.
    """
    if not isinstance(words, list):
        return []
    out: list[Word] = []
    for word in words:
        if not isinstance(word, dict):
            continue
        text = str(word.get("text") or "").strip()
        if not text:
            continue
        out.append(Word(
            text=text,
            start=_seconds(word.get("start")),
            end=_seconds(word.get("end")),
        ))
    return out


def _segments_from_words(words: Any) -> list[Segment]:
    """Fallback: rebuild turns by grouping consecutive words per speaker.

    Only reached when `utterances` is absent — which happens when
    `speaker_labels` was off. Coarser than AssemblyAI's own segmentation, but it
    beats returning nothing.
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
        text = str(word.get("text") or "").strip()
        if not text:
            continue
        speaker = word.get("speaker")

        if speaker != current_speaker and buffer:
            out.append(_turn(start, end, current_speaker, buffer))
            buffer = []

        if not buffer:
            start = _seconds(word.get("start"))
            current_speaker = speaker

        buffer.append(Word(
            text=text,
            start=_seconds(word.get("start")),
            end=_seconds(word.get("end")),
        ))
        end = _seconds(word.get("end"))

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
    """AssemblyAI's letter label -> the same "Speaker N" the app already uses.

    Deepgram produced "Speaker 1", "Speaker 2", … and the rename feature, the
    per-speaker colours and every stored transcript are built on that. Passing
    "A" through would make an old meeting and a new one look like different
    products, so the letter is mapped to its position in the alphabet.

    Anything unexpected — a number, None, a multi-character label — falls back
    to "Speaker 1" rather than inventing a label, matching the Deepgram adapter.
    """
    if isinstance(speaker, str):
        token = speaker.strip()
        if len(token) == 1 and token.isalpha():
            return f"Speaker {ord(token.upper()) - ord('A') + 1}"
        if token.isdigit():
            # Defensive: some AssemblyAI responses number speakers instead.
            return f"Speaker {int(token) + 1}"
        if token:
            # A real name (from speaker identification) is better than a number.
            return token
    if isinstance(speaker, int) and not isinstance(speaker, bool):
        return f"Speaker {speaker + 1}"
    return "Speaker 1"


def _join(segments: list[Segment]) -> str:
    """Render turns as "Speaker 1: ..." lines.

    The speaker prefix is deliberate: the LLM reads this text, and attributing
    an action item to the right person needs the attribution to be visible.
    """
    return "\n".join(f"{s.speaker}: {s.text}" for s in segments).strip()


def _seconds(value: Any) -> float:
    """Milliseconds -> seconds.

    The single most consequential line in this file. AssemblyAI reports
    milliseconds; `Segment.start/end` are seconds everywhere downstream. Getting
    this wrong raises nothing — it just puts every timestamp 1000x out, so the
    player seeks past the end of the audio and the meeting's inferred duration
    becomes absurd.
    """
    try:
        return float(value) / 1000.0
    except (TypeError, ValueError):
        return 0.0
