"""AssemblyAI speech-to-text: the canonical transcript.

This is the authoritative path. The browser also runs a live stream during the
meeting (see `app/streaming.py` and `frontend/lib/use-live-transcript.ts`), but
that is provisional and is replaced wholesale by whatever this returns. The two
optimise different things on purpose: streaming buys latency at the cost of
context, and this one has the entire recording to look at, so it wins.

Three differences from the Deepgram adapter are load-bearing and easy to get
silently wrong:

* **Timestamps are milliseconds here, seconds in Deepgram.** Everything
  downstream — the audio player, word highlighting, citation deep-links,
  `_duration_of` — reads `Segment.start/end` as seconds. A missed conversion
  does not raise; it makes a 40-minute meeting look 11 hours long.
* **Speakers are letters ("A", "B"), and they are cluster ids, not positions.**
  "D" does not mean "the fourth person" — it means whichever cluster the
  provider happened to put that voice in. Renumbering them meeting-locally is
  `app.diarization.CanonicalSpeakers`, and skipping it is how two people came
  to display as Speaker 1 and Speaker 4.
* **Attribution is per word, not only per utterance.** Reading only the
  utterance's label loses a short interjection inside a longer turn.
* **An unrecognisable speaker is not Speaker 1.** It used to be. See
  `app.diarization.UNKNOWN_SPEAKER`.

## What is sent, and why each field is conditional

Nothing here is sent unconditionally except the things that are always true.
The provider validates combinations and refuses some of them outright — one
pairing (`speakers_expected` with `speaker_options`) returns a 400 reading
"Both speaker_options and speakers_expected can not be used in the same
request" — so the request builder is a pure function with its own tests rather
than a dict assembled inline.

`keyterms_prompt` and `prompt` replace `word_boost`/`boost_param` on the
Universal-3 family. Contrary to what the docs imply, `word_boost` is *not*
rejected by `universal-3-5-pro` — a job submitted with it is accepted and
completes, verified against the live API — but it is the superseded channel and
the ceiling is far lower, so it is used only when universal-2 is the only model
in play.

## Failure is not an empty transcript

The old behaviour on any exception was to return an empty result, on the theory
that a meeting with no transcript is recoverable and a crashed worker is not.
That is right for a network blip and wrong for a malformed request: a 400
became a meeting that looked like it had been recorded in silence, and nothing
anywhere said otherwise. Configuration errors now raise, so the meeting fails
visibly with the provider's own message on it. Transport errors still retry,
and still degrade rather than crash.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.config import Settings
from app.diarization import (
    UNKNOWN_SPEAKER,
    CanonicalSpeakers,
    SpeakerIdentity,
    join_words,
    raw_token,
    split_by_speaker,
)
from app.diarization import SpokenWord as DiarizedWord
from app.diarization import trace_lines
from app.providers.ports import TranscriptionPort
from app.schemas import MeetingContext as MeetingContextSchema
from app.schemas import Segment, SpeakerExpectation, TranscriptResponse, Word
from app.transcription_context import (
    KEYTERMS_MAX_UNIVERSAL_2,
    KEYTERMS_MAX_UNIVERSAL_3,
    MeetingContext,
    TranscriptionContextBuilder,
)

logger = logging.getLogger("ai-service.assemblyai")

BASE_URL = "https://api.assemblyai.com/v2"
UPLOAD_URL = f"{BASE_URL}/upload"
TRANSCRIPT_URL = f"{BASE_URL}/transcript"

_EMPTY = TranscriptResponse(transcript="", language="en", segments=[])

#: Models that take `prompt` and the larger `keyterms_prompt` ceiling.
_UNIVERSAL_3_PREFIXES = ("universal-3", "slam-1")


class AudioUnreachableError(RuntimeError):
    """The provider accepted the job and could not fetch the audio.

    Its own words: "could not connect to the host". Distinguished from every
    other job failure because it is the one with an obvious next move — stop
    asking the provider to fetch, and send the bytes instead.
    """


class TranscriptionConfigurationError(RuntimeError):
    """The request Recallix built was refused. Retrying it will not help.

    Separate from every other failure because the handling is opposite: a
    transport error is worth another attempt and a bad parameter is worth a
    loud stop. Raised out of the adapter so the meeting fails with a message
    rather than completing with nothing in it.
    """


@dataclass(frozen=True)
class TranscriptionRequest:
    """Everything about one job that is not the audio itself.

    A value object rather than eight keyword arguments threaded through four
    call sites: it is passed unchanged from the Kafka event to the request
    builder, and adding a field should not mean editing every layer between.
    """

    language: str | None = None
    context: MeetingContext | None = None
    speakers: SpeakerExpectation = field(default_factory=SpeakerExpectation)
    #: Only when the channels are known to be one speaker each.
    multichannel: bool = False
    #: A short-lived URL the provider can fetch the audio from itself, which
    #: saves moving the whole file through this process. None means upload.
    audio_url: str | None = None

    @classmethod
    def from_event(
        cls,
        *,
        language: str | None,
        context: MeetingContextSchema | None,
        speakers: SpeakerExpectation | None,
        multichannel: bool = False,
        audio_url: str | None = None,
    ) -> "TranscriptionRequest":
        return cls(
            language=language,
            context=MeetingContext(
                title=context.title if context else None,
                project=context.project if context else None,
                meeting_type=context.meeting_type if context else None,
                organisations=list(context.organisations) if context else [],
            ) if context else None,
            speakers=(speakers or SpeakerExpectation()).normalised(),
            multichannel=multichannel,
            audio_url=audio_url,
        )


def keyterms_limit_for(models: list[str]) -> int:
    """The smallest ceiling any model in the priority list would accept.

    The list is a fallback chain, so a job may run on the second entry — and a
    thousand terms sent to a request that lands on universal-2 is a refusal for
    a reason nobody logged. Sizing to the weakest link costs a little bias on
    the happy path and removes a class of failure that only shows up on
    unusual languages.
    """
    if not models:
        return KEYTERMS_MAX_UNIVERSAL_2
    return min(
        KEYTERMS_MAX_UNIVERSAL_3
        if any(m.startswith(p) for p in _UNIVERSAL_3_PREFIXES)
        else KEYTERMS_MAX_UNIVERSAL_2
        for m in models
    )


def supports_prompt(models: list[str]) -> bool:
    """`prompt` is Universal-3.5 Pro only; the first model decides.

    The first rather than all: the fallback exists for languages the primary
    cannot do, and dropping the prompt because of a fallback that will probably
    never be reached would give up the feature on every ordinary job.
    """
    return bool(models) and models[0].startswith(_UNIVERSAL_3_PREFIXES)


def build_request(
    audio_url: str,
    models: list[str],
    request: TranscriptionRequest,
    *,
    configured_language: str | None = None,
) -> dict[str, Any]:
    """The exact JSON body for `POST /v2/transcript`.

    Pure, so the combination rules can be tested without a key or a network —
    which matters because the provider enforces some of them with a 400 and the
    rest by silently ignoring the field.
    """
    body: dict[str, Any] = {
        "audio_url": audio_url,
        "speech_models": list(models),
        # Turn-level and word-level speaker attribution. The whole reason this
        # adapter exists.
        "speaker_labels": True,
        # Not decoration: the provider refuses `speaker_labels` without it.
        "punctuate": True,
        # Numbers and dates in written form, which matters because action
        # items are extracted from this text.
        "format_text": True,
    }

    chosen = language_choice(request.language, configured_language)
    if chosen:
        body["language_code"] = chosen
    else:
        # Mutually exclusive with language_code; sending both is a 400.
        body["language_detection"] = True

    builder = TranscriptionContextBuilder(keyterms_limit=keyterms_limit_for(models))
    context = builder.build(request.context)

    if context.keyterms:
        if _uses_keyterms(models):
            body["keyterms_prompt"] = context.keyterms
        else:
            # universal-2 only. The superseded channel, and the one that model
            # still honours.
            body["word_boost"] = context.keyterms[:KEYTERMS_MAX_UNIVERSAL_2]
            body["boost_param"] = "high"

    if context.prompt and supports_prompt(models):
        body["prompt"] = context.prompt

    _apply_speakers(body, request.speakers)

    if request.multichannel:
        body["multichannel"] = True

    return body


def _uses_keyterms(models: list[str]) -> bool:
    """True unless every model in the chain predates keyterms prompting."""
    return any(m.startswith(_UNIVERSAL_3_PREFIXES) for m in models)


def _apply_speakers(body: dict[str, Any], speakers: SpeakerExpectation) -> None:
    """Constrain diarization, or say nothing at all.

    The two fields cannot be combined — the provider answers a request carrying
    both with `HTTP 400 "Both speaker_options and speakers_expected can not be
    used in the same request."` — so this is an if/elif and not two ifs.

    Auto sends neither. That is deliberate and is the default: an exact count
    is a hard constraint, and a wrong one splits two people into four or merges
    four into two. Nothing infers it.
    """
    settled = speakers.normalised()
    if settled.mode == "exact" and settled.exact is not None:
        body["speakers_expected"] = settled.exact
        return
    if settled.mode == "range":
        options: dict[str, int] = {}
        if settled.minimum is not None:
            options["min_speakers_expected"] = settled.minimum
        if settled.maximum is not None:
            options["max_speakers_expected"] = settled.maximum
        if options:
            body["speaker_options"] = options


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

    def _models(self) -> list[str]:
        models = [self._settings.assemblyai_model]
        if self._settings.assemblyai_fallback_model:
            models.append(self._settings.assemblyai_fallback_model)
        return models

    # --- the port ----------------------------------------------------------- #
    async def transcribe(
        self,
        audio: bytes,
        filename: str,
        language: str | None = None,
        *,
        request: TranscriptionRequest | None = None,
    ) -> TranscriptResponse:
        job = request or TranscriptionRequest(language=language)
        # The positional argument still wins when both are given: it is what the
        # older call sites pass, and silently preferring an empty field on a
        # default-constructed request would drop it.
        if language and not job.language:
            job = TranscriptionRequest(**{**job.__dict__, "language": language})

        attempts = self._settings.assemblyai_max_retries + 1
        delay = 1.0
        for attempt in range(1, attempts + 1):
            try:
                return await self._run(audio, job)
            except (TranscriptionConfigurationError, AudioUnreachableError):
                # Neither is worth retrying unchanged: a refused request is
                # refused again, and an unreachable URL stays unreachable. Both
                # go up to a caller that can do something about it.
                raise
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

    async def _run(self, audio: bytes, job: TranscriptionRequest) -> TranscriptResponse:
        if self._client is not None:
            return await self._transcribe_with(self._client, audio, job)
        timeout = httpx.Timeout(self._settings.assemblyai_timeout_seconds, connect=15.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            return await self._transcribe_with(client, audio, job)

    async def _transcribe_with(
        self, client: httpx.AsyncClient, audio: bytes, job: TranscriptionRequest
    ) -> TranscriptResponse:
        started = time.perf_counter()
        # The provider fetches it itself when Recallix can hand over a URL,
        # which is one whole-file transfer instead of two. See app/storage.py
        # for why the URL is short-lived and why the bucket stays private.
        source = job.audio_url or await self._upload(client, audio)
        fetched = job.audio_url is not None

        models = self._models()
        body = build_request(
            source, models, job, configured_language=self._settings.assemblyai_language
        )
        job_id = await self._submit(client, body)
        payload = await self._poll(client, job_id)
        result = parse_response(payload)

        _log_job(
            payload=payload,
            body=body,
            models=models,
            result=result,
            seconds=time.perf_counter() - started,
            fetched_by_provider=fetched,
        )
        return result

    # --- the round trips ---------------------------------------------------- #
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

    async def _submit(self, client: httpx.AsyncClient, body: dict[str, Any]) -> str:
        response = await client.post(TRANSCRIPT_URL, headers=self._headers(), json=body)
        if response.status_code == 400 or response.status_code == 422:
            # Our fault, and the message says which field. Named explicitly so
            # the retry loop lets it out instead of trying the same bad
            # request twice more and calling the result a quiet meeting.
            raise TranscriptionConfigurationError(
                f"AssemblyAI refused the request: {_error_text(response)}"
            )
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
                message = str(payload.get("error") or "")
                if _is_download_failure(message):
                    # Named so the caller can do the one useful thing: send the
                    # bytes rather than a URL. Retrying the same unreachable
                    # URL two more times, then returning an empty transcript,
                    # is what this used to do.
                    raise AudioUnreachableError(message)
                raise RuntimeError(f"AssemblyAI transcription failed: {message}")
            if asyncio.get_running_loop().time() >= deadline:
                raise TimeoutError(
                    f"AssemblyAI job {job_id} still {status or 'unknown'} after "
                    f"{self._settings.assemblyai_timeout_seconds:.0f}s"
                )
            await asyncio.sleep(interval)


def _is_download_failure(message: str) -> bool:
    """Did the provider fail because it could not reach the audio?

    Matched on the message because the API reports it as an ordinary job error
    with no distinguishing code. Deliberately narrow: a false positive here
    would re-upload a whole recording after an unrelated failure.
    """
    lowered = message.lower()
    return "download error" in lowered or "unable to download" in lowered


def _error_text(response: httpx.Response) -> str:
    try:
        payload = response.json() or {}
    except Exception:  # noqa: BLE001 — a 400 need not be JSON.
        return response.text[:300]
    return str(payload.get("error") or payload.get("detail") or payload)[:300]


# --------------------------------------------------------------------------- #
# Telemetry — facts about the job, never a word of what was said.
# --------------------------------------------------------------------------- #

def _log_job(
    *,
    payload: dict[str, Any],
    body: dict[str, Any],
    models: list[str],
    result: TranscriptResponse,
    seconds: float,
    fetched_by_provider: bool,
) -> None:
    """One structured line per job.

    Deliberately excludes the transcript, the prompt text and the keyterms
    themselves. The prompt is built from meeting titles and colleagues' names,
    so logging it would put meeting content in a log aggregator by the back
    door — the count is what a diagnosis needs, and the count is what is here.
    """
    speakers = {s.speaker for s in result.segments}
    logger.info(
        "assemblyai.job",
        extra={
            "provider": "assemblyai",
            "models_requested": models,
            # What actually ran, which is not always what was asked for.
            "model_used": payload.get("speech_model") or (payload.get("speech_models") or [None])[0],
            "language_requested": body.get("language_code"),
            "language_detected": result.language,
            "language_detection": bool(body.get("language_detection")),
            "audio_seconds": payload.get("audio_duration"),
            "source_fetched_by_provider": fetched_by_provider,
            "speaker_count": len(speakers),
            "speakers_constrained": "speakers_expected" in body or "speaker_options" in body,
            # What the provider was actually told to look for. Auto -- nothing
            # sent -- means the provider's own ceiling applies, which is 10 for
            # audio between two and ten minutes and 30 beyond that. A 30-wide
            # search on a two-person meeting is the documented way one person
            # fragments across several labels, so which of those a job ran
            # under is the first thing worth knowing about a bad one.
            "speaker_constraint": (
                body.get("speakers_expected")
                if "speakers_expected" in body
                else body.get("speaker_options") or "auto"
            ),
            # Provider cluster id -> what Recallix displayed. Letters and
            # numbers only, no transcript content, and the one thing that
            # distinguishes "the provider merged two people" from "Recallix
            # mislabelled one" once the job is over.
            "diarization_map": {
                s.speaker_raw: s.speaker for s in result.segments if s.speaker_raw
            },
            "multichannel": bool(body.get("multichannel")),
            "prompted": "prompt" in body,
            "keyterm_count": len(body.get("keyterms_prompt") or body.get("word_boost") or []),
            "keyterm_channel": "keyterms_prompt" if "keyterms_prompt" in body
            else ("word_boost" if "word_boost" in body else None),
            "segment_count": len(result.segments),
            "word_count": sum(len(s.words) for s in result.segments),
            "unattributed_segments": sum(
                1 for s in result.segments if s.speaker_status == "unknown"
            ),
            "processing_seconds": round(seconds, 2),
        },
    )


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


def parse_response(payload: dict[str, Any]) -> TranscriptResponse:
    """Map AssemblyAI's response onto the shape the rest of the pipeline expects.

    One `CanonicalSpeakers` for the whole response, fed in chronological order,
    is what makes the numbering meeting-local and deterministic: the first voice
    heard is Speaker 1 whatever letter the provider gave it, and reprocessing
    the same payload renumbers it identically.
    """
    language = _language_of(payload)
    multichannel = bool(payload.get("multichannel"))
    speakers = CanonicalSpeakers()

    segments = _segments_from_utterances(payload.get("utterances"), speakers, multichannel)
    if not segments:
        segments = _segments_from_words(payload.get("words"), speakers, multichannel)

    # Prefer text rebuilt from the segments: it carries the speaker turns and
    # the line breaks between them, which the flat `text` string does not.
    transcript = _join(segments) or str(payload.get("text") or "").strip()

    logger.info(
        "AssemblyAI returned %d segment(s) across %d speaker(s), language=%s. "
        "Provider labels %s mapped to canonical speakers in order of first appearance.",
        len(segments), speakers.count, language, sorted(speakers.mapping()),
    )
    _trace(segments)
    return TranscriptResponse(transcript=transcript, language=language, segments=segments)


def _trace(segments: list[Segment]) -> None:
    """The §30 diarization trace, off unless someone has asked for it.

    Gated on the logger's own DEBUG level rather than on a new setting: it is
    the mechanism that already exists, it is off in every deployment that has
    not deliberately turned it on, and it needs no configuration surface to
    maintain.

    It prints words, so it is developer-only by construction — never emitted at
    INFO, never in the structured telemetry, and not something to leave on in a
    deployment holding other people's meetings.
    """
    if not logger.isEnabledFor(logging.DEBUG):
        return
    for line in trace_lines(segments):
        logger.debug("diarization %s", line)


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


def _segments_from_utterances(
    utterances: Any, speakers: CanonicalSpeakers, multichannel: bool = False
) -> list[Segment]:
    """Primary path: AssemblyAI has already grouped words into speaker turns.

    Its grouping is good — measured against spliced two-voice audio with known
    boundaries, it puts a one-word "Exactly." on its own utterance with its own
    label — so an utterance whose words all agree is emitted intact, keeping the
    provider's punctuation and casing exactly as given.

    The word-level pass is for the case where they *don't* agree. Recallix used
    to read only `utterance["speaker"]`, which meant a speaker change inside an
    utterance was unrepresentable: the interjection was absorbed into whichever
    turn surrounded it, and the words that proved otherwise were discarded on
    the way past. Now the utterance's own label is the fallback, and the words
    outrank it.
    """
    if not isinstance(utterances, list):
        return []
    out: list[Segment] = []
    for utterance in utterances:
        if not isinstance(utterance, dict):
            continue
        text = str(utterance.get("text") or "").strip()
        if not text:
            continue

        channel = utterance.get("channel") if multichannel else None
        raw_words = utterance.get("words")
        # The utterance's own label, or failing that the first word inside it
        # that carries one. Without the second half, an utterance whose opening
        # words are unattributed starts with an "Unknown speaker" fragment
        # before naming the person who said the rest of the same sentence --
        # a worse answer than the one the utterance already contains.
        parent = raw_token(utterance.get("speaker"), channel=channel) or _first_token(raw_words)
        words = _diarized_words(raw_words, fallback=parent)
        confidence = _confidence(utterance.get("confidence"))

        if not words:
            # No word detail: the utterance's own label is all there is.
            identity = speakers.for_token(parent)
            out.append(_segment(
                start=_seconds(utterance.get("start")),
                end=_seconds(utterance.get("end")),
                identity=identity,
                text=text,
                words=[],
                confidence=confidence,
            ))
            continue

        runs = split_by_speaker(words, speakers)
        if len(runs) == 1:
            # The provider's own text, untouched — it is better formatted than
            # anything rebuilt from the word list.
            out.append(_segment(
                start=_seconds(utterance.get("start")),
                end=_seconds(utterance.get("end")),
                identity=runs[0].identity,
                text=text,
                words=runs[0].words,
                confidence=confidence,
            ))
            continue

        for run in runs:
            out.append(_segment(
                start=run.start,
                end=run.end,
                identity=run.identity,
                text=join_words(run.words, capitalise=run.split),
                words=run.words,
                # The utterance's confidence described the whole utterance; it
                # is not a claim about a fragment of it.
                confidence=None,
            ))
    return out


def _segment(
    *,
    start: float,
    end: float,
    identity: SpeakerIdentity,
    text: str,
    words: list[DiarizedWord],
    confidence: float | None,
) -> Segment:
    """Assemble a canonical segment, stamping identity onto every word.

    The per-word labels are what the §30 trace reads, and what tells a future
    reader whether a wrong name came from the provider or from here.
    """
    return Segment(
        start=start,
        end=end,
        speaker=identity.label,
        speaker_key=identity.key,
        speaker_raw=identity.raw,
        speaker_status=identity.status,
        text=text,
        confidence=confidence,
        words=[
            Word(
                text=word.text,
                start=word.start,
                end=word.end,
                confidence=word.confidence,
                speaker=identity.label,
                speaker_raw=word.speaker or identity.raw,
            )
            for word in words
        ],
    )


def _first_token(words: Any) -> str | None:
    """The first word in an utterance the provider was willing to attribute."""
    if not isinstance(words, list):
        return None
    for word in words:
        if isinstance(word, dict):
            token = raw_token(word.get("speaker"))
            if token is not None:
                return token
    return None


def _diarized_words(words: Any, *, fallback: str | None = None) -> list[DiarizedWord]:
    """Per-word timings **and attribution**, which drive the highlight and the split.

    AssemblyAI nests these inside each utterance and also lists them at the top
    level. They are the reason this adapter can highlight accurately where the
    previous one had to estimate — an utterance here can run half a minute, and
    an even-rate guess over that span drifts far enough to point at the wrong
    sentence — and, since diarization attributes per word, the reason a
    mid-utterance speaker change is recoverable at all.

    `fallback` is the parent utterance's label, used only for words the provider
    left unattributed inside an otherwise attributed turn.
    """
    if not isinstance(words, list):
        return []
    out: list[DiarizedWord] = []
    for word in words:
        if not isinstance(word, dict):
            continue
        text = str(word.get("text") or "").strip()
        if not text:
            continue
        out.append(DiarizedWord(
            text=text,
            start=_seconds(word.get("start")),
            end=_seconds(word.get("end")),
            confidence=_confidence(word.get("confidence")),
            speaker=raw_token(word.get("speaker")) or fallback,
        ))
    return out


def _segments_from_words(
    words: Any, speakers: CanonicalSpeakers, multichannel: bool = False
) -> list[Segment]:
    """Fallback: rebuild turns by grouping consecutive words per speaker.

    Only reached when `utterances` is absent — which happens when
    `speaker_labels` was off, and on the odd response that returns words alone.
    Coarser than AssemblyAI's own segmentation because there is no
    provider-formatted utterance text to keep, but it beats returning nothing.
    """
    if not isinstance(words, list) or not words:
        return []

    parsed = _diarized_words(words)
    if not parsed:
        return []

    return [
        _segment(
            start=run.start,
            end=run.end,
            identity=run.identity,
            # Every run here begins a turn, and there is no provider-formatted
            # utterance text to defer to on this path — all of it is rebuilt —
            # so all of it gets sentence-cased rather than only the fragments.
            text=join_words(run.words, capitalise=True),
            words=run.words,
            confidence=None,
        )
        for run in split_by_speaker(parsed, speakers)
    ]


def _confidence(value: Any) -> float | None:
    """0-1, or None when the provider did not say.

    None rather than 0.0: a missing confidence and a confidence of zero mean
    opposite things, and anything averaging these would be dragged to the floor
    by every provider that omits the field.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if number != number:  # NaN
        return None
    return max(0.0, min(1.0, number))


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
