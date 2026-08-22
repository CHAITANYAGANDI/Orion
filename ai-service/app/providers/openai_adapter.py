"""OpenAI adapters — Whisper transcription + chat-completions extraction.

Extraction uses JSON mode with prompts that instruct the model to extract only
what is explicitly present in the transcript and to quote the exact source
sentence. A light circuit-breaker (bounded retries + timeout + empty fallback)
wraps every call so a provider outage degrades to an empty structured result
rather than a 500.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import re
from typing import Any, Awaitable, Callable, TypeVar

from openai import AsyncOpenAI

from app import answering
from app.answering import Answer
from app.config import Settings
from app.providers.ports import EmbeddingPort, LlmPort, TranscriptionPort
from app.questions import Knowledge
from app.schemas import (
    ActionItem,
    DraftEmailRequest,
    DraftEmailResponse,
    OutlineGroup,
    Segment,
    SummaryResponse,
    SummarySection,
    SummaryTemplate,
    TranscriptResponse,
)
from app.templates import resolve

logger = logging.getLogger("ai-service.openai")

T = TypeVar("T")


# A rate limit is not a failure, it is an instruction to wait. Capped so a
# pathological value cannot wedge the pipeline behind one call.
_RATE_LIMIT_MAX_WAIT = 65.0
_RETRY_AFTER_PATTERN = re.compile(r"try again in ([0-9.]+)\s*s", re.IGNORECASE)


def _rate_limit_wait(exc: Exception) -> float | None:
    """How long the server asked us to wait, or None if this is not a 429.

    Read from the `retry-after` header when present, otherwise from the
    message, which is where OpenAI puts the precise figure ("try again in
    21.52s"). A tenth of a second is added because retrying at the exact
    boundary tends to be refused again.
    """
    if getattr(exc, "status_code", None) != 429 and type(exc).__name__ != "RateLimitError":
        return None

    header = None
    response = getattr(exc, "response", None)
    if response is not None:
        try:
            header = response.headers.get("retry-after")
        except Exception:  # noqa: BLE001 — header shape varies by SDK version.
            header = None
    if header:
        try:
            return min(float(header) + 0.1, _RATE_LIMIT_MAX_WAIT)
        except (TypeError, ValueError):
            pass

    match = _RETRY_AFTER_PATTERN.search(str(exc))
    if match:
        return min(float(match.group(1)) + 0.1, _RATE_LIMIT_MAX_WAIT)
    # A 429 with no stated delay still deserves longer than the generic backoff.
    return 20.0


async def _with_retries(
    op: Callable[[], Awaitable[T]],
    *,
    attempts: int,
    fallback: T,
    label: str,
) -> T:
    """Run `op` with bounded retries + exponential backoff.

    On exhaustion, log and return `fallback` instead of raising — the
    circuit-breaker-ish behaviour required by the spec.

    Rate limits are waited out rather than backed off from. The generic
    backoff starts at half a second and triples by the third attempt, so a
    limit that asks for twenty seconds used to burn every attempt inside three
    — and return an empty brief for a meeting that had simply arrived too
    quickly after the last one.
    """
    delay = 0.5
    for attempt in range(1, attempts + 1):
        try:
            return await op()
        except Exception as exc:  # noqa: BLE001 — deliberately broad; we degrade.
            wait = _rate_limit_wait(exc)
            logger.warning(
                "OpenAI %s failed (attempt %d/%d)%s: %s",
                label, attempt, attempts,
                f"; rate limited, waiting {wait:.1f}s" if wait else "",
                exc,
            )
            if attempt >= attempts:
                logger.error("OpenAI %s exhausted retries; returning fallback.", label)
                return fallback
            if wait is not None:
                await asyncio.sleep(wait)
            else:
                await asyncio.sleep(delay)
                delay *= 2
    return fallback


# How much of a list goes into one translation request. Both limits matter: the
# character budget keeps a chunk of long paragraphs inside the context, and the
# line count keeps a chunk of one-word utterances — a transcript is full of
# "Yeah." — from becoming four hundred items the model has to keep aligned.
_TRANSLATE_CHUNK_CHARS = 5000
_TRANSLATE_CHUNK_LINES = 40


def _chunk_lines(lines: list[str]) -> list[list[str]]:
    """Split a list into request-sized batches, never splitting a line."""
    chunks: list[list[str]] = []
    current: list[str] = []
    size = 0
    for line in lines:
        length = len(line) + 8  # the index prefix and newline
        if current and (
            size + length > _TRANSLATE_CHUNK_CHARS
            or len(current) >= _TRANSLATE_CHUNK_LINES
        ):
            chunks.append(current)
            current, size = [], 0
        current.append(line)
        size += length
    if current:
        chunks.append(current)
    return chunks


def prompt_hint(vocabulary: list[str] | None, limit: int = 200) -> str:
    """The user's vocabulary as a Whisper decoding prompt.

    Whisper's prompt is capped at 224 tokens and silently truncates past it, so
    the list is bounded here — a prompt that runs off the end would drop terms
    without saying so. Kept well under the ceiling because the tail of the list
    is worth less than a prompt that certainly fits.
    """
    if not vocabulary:
        return ""
    terms: list[str] = []
    seen: set[str] = set()
    for raw in vocabulary:
        term = str(raw or "").strip()
        if not term:
            continue
        key = term.lower()
        if key in seen:
            continue
        seen.add(key)
        terms.append(term)
        if len(terms) >= limit:
            break
    if not terms:
        return ""
    return "Vocabulary used in this recording: " + ", ".join(terms) + "."


class OpenAiTranscriptionAdapter(TranscriptionPort):
    """Whisper transcription via the OpenAI SDK."""

    def __init__(self, settings: Settings, client: AsyncOpenAI | None = None) -> None:
        self._settings = settings
        self._client = client or AsyncOpenAI(
            api_key=settings.openai_api_key,
            timeout=settings.openai_timeout_seconds,
            max_retries=0,  # we manage retries ourselves
        )

    async def transcribe(
        self,
        audio: bytes,
        filename: str,
        vocabulary: list[str] | None = None,
        language: str | None = None,
        *,
        request=None,  # noqa: ARG002 - accepted for the port, unused here.
    ) -> TranscriptResponse:
        async def _op() -> TranscriptResponse:
            buffer = io.BytesIO(audio)
            buffer.name = filename or "audio.wav"
            request: dict[str, Any] = {
                "model": self._settings.openai_transcribe_model,
                "file": buffer,
                "response_format": "verbose_json",
            }
            # Whisper takes the language as an ISO-639-1 code and detects when
            # it is absent, which is exactly this setting's contract.
            if (language or "").strip():
                request["language"] = language.strip()
            # Whisper has no boosting parameter. Its `prompt` is the documented
            # stand-in: it biases decoding toward the style and spellings it
            # contains. Comma-separated terms are the shape OpenAI's own
            # guidance uses for exactly this — getting names and jargon spelled
            # the way the user spells them.
            hint = prompt_hint(vocabulary)
            if hint:
                request["prompt"] = hint
            resp: Any = await self._client.audio.transcriptions.create(**request)
            text = getattr(resp, "text", "") or ""
            language = getattr(resp, "language", "en") or "en"
            segments: list[Segment] = []
            for seg in getattr(resp, "segments", None) or []:
                # verbose_json segments are objects or dicts depending on SDK version.
                get = seg.get if isinstance(seg, dict) else lambda k, d=None: getattr(seg, k, d)
                segments.append(
                    Segment(
                        start=float(get("start", 0.0) or 0.0),
                        end=float(get("end", 0.0) or 0.0),
                        speaker="S1",  # Whisper does not diarize; single speaker label.
                        text=str(get("text", "") or "").strip(),
                    )
                )
            return TranscriptResponse(transcript=text.strip(), language=language, segments=segments)

        return await _with_retries(
            _op,
            attempts=self._settings.openai_max_retries + 1,
            fallback=TranscriptResponse(transcript="", language="en", segments=[]),
            label="transcribe",
        )


_EXTRACTION_SYSTEM = (
    "You are a meticulous meeting-notes analyst. Extract ONLY information that is "
    "explicitly stated in the transcript. Do not infer, invent, or generalize. "
    "For every extracted item, include the exact verbatim source sentence from the "
    "transcript in `sourceSentence`. If nothing qualifies, return an empty list. "
    "Respond with a single JSON object only."
)

# The entity pass needs the same discipline WITHOUT the sourceSentence rule:
# under that rule the model wraps each name in an object to carry the quote,
# and a list of names is the whole point here.
_ENTITY_SYSTEM = (
    "You are a meticulous meeting-notes analyst. List ONLY what is explicitly "
    "named in the transcript. Do not infer, invent, or generalize. Every array "
    "element must be a plain string — the name alone, with no quote, no "
    "explanation and no surrounding object. Respond with a single JSON object only."
)

# ISO-639-1 codes we can name explicitly. Naming the language works markedly
# better than passing a bare code, which models sometimes misread.
_LANGUAGE_NAMES = {
    "en": "English", "es": "Spanish", "fr": "French", "de": "German",
    "it": "Italian", "pt": "Portuguese", "nl": "Dutch", "pl": "Polish",
    "ru": "Russian", "uk": "Ukrainian", "tr": "Turkish", "ar": "Arabic",
    "he": "Hebrew", "hi": "Hindi", "bn": "Bengali", "ta": "Tamil",
    "te": "Telugu", "mr": "Marathi", "gu": "Gujarati", "kn": "Kannada",
    "ml": "Malayalam", "pa": "Punjabi", "ur": "Urdu", "zh": "Chinese",
    "ja": "Japanese", "ko": "Korean", "vi": "Vietnamese", "th": "Thai",
    "id": "Indonesian", "ms": "Malay", "sv": "Swedish", "da": "Danish",
    "nb": "Norwegian", "no": "Norwegian", "fi": "Finnish", "cs": "Czech",
    "el": "Greek", "ro": "Romanian", "hu": "Hungarian", "fa": "Persian",
}


def _format_duration(seconds: float) -> str:
    """Seconds as H:MM:SS, or M:SS under an hour — how a player shows it."""
    total = int(round(seconds))
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def _recording_facts(duration_seconds: float | None, speaker_count: int | None) -> str:
    """State the length and turnout so the notes can open with them.

    Neither is recoverable from the transcript text, and both are the first
    thing a reader wants: how long this ran, and how many people were in it.
    """
    facts = []
    if duration_seconds and duration_seconds > 0:
        facts.append(f"length {_format_duration(duration_seconds)}")
    if speaker_count and speaker_count > 0:
        facts.append(f"{speaker_count} speaker{'s' if speaker_count != 1 else ''}")
    if not facts:
        return ""
    return (
        "Facts about the recording, not present in the transcript: "
        + ", ".join(facts)
        + ". Open `shortSummary` by stating these.\n\n"
    )


def _assemble(tpl: SummaryTemplate, data: dict[str, Any]) -> SummaryResponse:
    """Map a template reply onto sections, and back onto the legacy fields.

    `shortSummary`, `detailedSummary` and `keyPoints` are still populated
    because the markdown export, the public share page and the recap email all
    read them and none of them should have to know which template ran. They are
    derived from whichever sections best correspond, so a template without a
    key-points section simply leaves that list empty rather than breaking.

    Every section is tolerant of the wrong shape arriving — a model that
    returns a string where an array was asked for yields a one-item list rather
    than an exception, because a slightly odd section is worth far more to the
    reader than a failed brief.
    """
    sections: list[SummarySection] = []
    for spec in tpl.sections:
        raw = data.get(spec.key)
        section = SummarySection(key=spec.key, title=spec.title, kind=spec.kind)

        if spec.kind == "prose":
            section.text = str(raw or "").strip()
        elif spec.kind == "bullets":
            items = raw if isinstance(raw, list) else ([raw] if raw else [])
            section.bullets = [str(b).strip() for b in items if str(b or "").strip()]
        else:  # outline
            for group in raw if isinstance(raw, list) else []:
                if not isinstance(group, dict):
                    continue
                heading = str(group.get("heading", "")).strip()
                bullets = group.get("bullets")
                bullets = bullets if isinstance(bullets, list) else []
                cleaned = [str(b).strip() for b in bullets if str(b or "").strip()]
                if heading or cleaned:
                    section.groups.append(
                        OutlineGroup(
                            heading=heading,
                            bullets=cleaned,
                            # Unverified here, and stored as such: the adapter
                            # has the model's reply but not the segments, so the
                            # pipeline resolves it. See quotes.anchor_outline.
                            start_quote=str(group.get("startQuote", "") or "").strip(),
                        )
                    )

        sections.append(section)

    by_key = {s.key: s for s in sections}
    overview = by_key.get("overview")
    key_points = next((s for s in sections if s.kind == "bullets"), None)

    # The flat rendering used by export and email: every section in order, its
    # title followed by its content, so nothing a template added is lost to a
    # reader who only ever sees the markdown.
    detailed = "\n\n".join(_flatten(s) for s in sections if _flatten(s))

    return SummaryResponse(
        short_summary=(overview.text if overview else "") or (detailed.split("\n\n")[0] if detailed else ""),
        detailed_summary=detailed,
        key_points=list(key_points.bullets) if key_points else [],
        sections=sections,
        template_slug=tpl.slug,
    )


def _flatten(section: SummarySection) -> str:
    """One section as plain text, for the markdown export and the recap email."""
    if section.kind == "prose":
        body = section.text
    elif section.kind == "bullets":
        body = "\n".join(f"- {b}" for b in section.bullets)
    else:
        body = "\n\n".join(
            "\n".join([g.heading, *(f"- {b}" for b in g.bullets)]).strip()
            for g in section.groups
        )
    body = body.strip()
    return f"{section.title}\n{body}" if body else ""


def _language_instruction(language: str | None) -> str:
    """Tell the model which language to write the brief in.

    English is the no-op case: the base prompts are already English, and adding
    a redundant instruction only costs tokens.

    The `sourceSentence` carve-out matters. Those are verbatim quotes used to
    show the user exactly what was said, and Meeting Memory matches against
    them; a translated quote would be neither verbatim nor matchable.
    """
    code = (language or "en").strip().lower()[:2]
    if not code or code == "en":
        return ""
    name = _LANGUAGE_NAMES.get(code)
    target = name if name else f"the language with ISO code '{code}'"
    return (
        f" The transcript is in {target}. Write every summary, title, and "
        f"description in {target} so the notes are readable by the people who "
        "were in the meeting. Do NOT translate `sourceSentence` — it must stay "
        "the exact words from the transcript."
    )


class OpenAiLlmAdapter(LlmPort):
    """Chat-completions summarization + JSON-mode structured extraction."""

    def __init__(self, settings: Settings, client: AsyncOpenAI | None = None) -> None:
        self._settings = settings
        self._client = client or AsyncOpenAI(
            api_key=settings.openai_api_key,
            timeout=settings.openai_timeout_seconds,
            max_retries=0,
        )
        # The pipeline deliberately fans out summary and all three extractions
        # at once, and each carries the whole transcript. On an account with a
        # modest tokens-per-minute allowance that burst is refused outright —
        # every call in the fan-out counts against the same minute.
        #
        # Gated per model, because that is how the allowance is granted: the
        # extraction model having room to spare must not be spent throttling
        # it alongside the summary model that has none.
        self._gates: dict[str, asyncio.Semaphore] = {}

    def _gate_for(self, model: str) -> asyncio.Semaphore:
        gate = self._gates.get(model)
        if gate is None:
            gate = asyncio.Semaphore(max(1, self._settings.openai_max_concurrent_calls))
            self._gates[model] = gate
        return gate

    async def _chat_json(
        self, system: str, user: str, *, model: str | None = None
    ) -> dict[str, Any]:
        chosen = model or self._settings.openai_chat_model
        kwargs: dict[str, Any] = {
            "model": chosen,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        # Only sent when explicitly configured: current models reject an
        # explicit temperature and accept only their own default.
        if self._settings.openai_temperature is not None:
            kwargs["temperature"] = self._settings.openai_temperature

        async with self._gate_for(chosen):
            resp: Any = await self._client.chat.completions.create(**kwargs)
        content = resp.choices[0].message.content or "{}"
        return json.loads(content)

    async def _chat_text(self, system: str, user: str, *, model: str | None = None) -> str:
        """Plain-prose sibling of `_chat_json`, for answers and translations.

        Shares the gate and the temperature handling deliberately: when these
        were built inline they kept their own `temperature=0`, and the model
        change that broke the brief would have silently broken RAG chat and
        translation too.
        """
        chosen = model or self._settings.openai_chat_model
        kwargs: dict[str, Any] = {
            "model": chosen,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        if self._settings.openai_temperature is not None:
            kwargs["temperature"] = self._settings.openai_temperature

        async with self._gate_for(chosen):
            resp: Any = await self._client.chat.completions.create(**kwargs)
        return (resp.choices[0].message.content or "").strip()

    async def _named_entities(self, transcript: str, language: str) -> list[str]:
        """Every concrete thing the meeting named, pulled out on its own.

        Asked separately because a model writing prose compresses, and the
        first casualties are exactly the names that make notes worth reading —
        the scanner nobody else has heard of, the one integration that shipped.
        Listing them first, then handing the list back for the summary to draw
        on, keeps them from being smoothed away.

        Failure is not fatal: an empty list simply means the summary is written
        the way it was before, so a flaky extra call degrades quality rather
        than losing the brief.
        """
        user = (
            "List the named things this meeting actually worked on, as JSON: "
            '{"entities":["..."]}. Include a product, feature, tool, service, '
            "vendor, integration, event or release only when it was proposed, "
            "chosen, compared, scheduled, built or ruled on.\n"
            "Exclude: people's names; generic nouns (docs, spreadsheets, "
            "meeting); job titles and team names; and anything that came up "
            "only in a joke, an aside or social chat. A film someone "
            "recommended is not an entity.\n"
            "Use the exact form the transcript uses, even when it looks "
            "misspelt — it is a transcription of speech and the odd-looking "
            "form is usually the real product name. Return at most 25, most "
            "significant first, no duplicates."
            "\n\nTranscript:\n" + transcript
        )
        data = await self._chat_json(
            _ENTITY_SYSTEM + _language_instruction(language),
            user,
            model=self._settings.openai_extraction_model,
        )

        # Dedupe here rather than trusting the instruction: repeats crowd out
        # the tail of the list, and the tail is where the unusual names live.
        seen: set[str] = set()
        entities: list[str] = []
        for raw in data.get("entities", []):
            # Tolerate {"name": ...} as well as a bare string. Asking for a
            # plain list is not a guarantee of getting one, and a stringified
            # dict reaching the summary prompt is worse than a dropped entity.
            name = str(raw.get("name", "") if isinstance(raw, dict) else raw).strip()
            key = name.casefold()
            if name and key not in seen:
                seen.add(key)
                entities.append(name)
        return entities[:25]

    async def summarize(
        self,
        transcript: str,
        language: str = "en",
        *,
        duration_seconds: float | None = None,
        speaker_count: int | None = None,
        template: SummaryTemplate | None = None,
    ) -> SummaryResponse:
        tpl = template or resolve(None)
        entities = await _with_retries(
            lambda: self._named_entities(transcript, language),
            attempts=self._settings.openai_max_retries + 1,
            fallback=[],
            label="named_entities",
        )

        async def _op() -> SummaryResponse:
            # The template decides which sections exist and what each must
            # contain; only the house rules that apply to every section live
            # here. Sections are asked for by key so the reply can be mapped
            # back without depending on the model echoing titles verbatim.
            #
            # Plain text within a section, deliberately: the UI renders prose
            # into a <p> with `whitespace-pre-wrap`, so blank lines survive but
            # markdown does not — a "##" would reach the user as literal "##".
            shape = {
                "prose": "a single string of plain prose",
                "bullets": "an array of strings",
                "outline": (
                    'an array of {"heading": string, "startQuote": string, '
                    '"bullets": [string]}'
                ),
            }
            spec = "\n".join(
                f'- "{sec.key}" ({sec.title}) -> {shape[sec.kind]}. {sec.instruction}'
                for sec in tpl.sections
            )
            system = (
                "You write meeting notes for someone who was not there and now "
                "has to act. Return a JSON object whose keys are exactly: "
                + ", ".join(f'"{sec.key}"' for sec in tpl.sections)
                + ".\n\n"
                + spec
                + "\n\n"
                "Keep every concrete detail the transcript states: product and "
                "feature names, tool and vendor names, event names, numbers, "
                "dates and deadlines, chosen wording. These are the whole value "
                "of the notes — a summary that drops them is worthless. If a "
                "deadline or a final wording was agreed, it must appear, quoted "
                "exactly.\n"
                "Where the meeting worked through candidates, options or "
                "examples, name them outright rather than reporting that a list "
                "existed.\n"
                "Ignore small talk, jokes and asides that carry no decision, "
                "except where a section explicitly asks for the whole meeting. "
                "Base everything strictly on the transcript; never infer or "
                "invent. Plain text only — no markdown, no '#', no '*', no "
                "bullet characters; the bullets are the JSON array itself.\n"
                "A section with nothing to report gets an empty string or an "
                "empty array — never a sentence apologising for it."
                + _language_instruction(language)
            )

            preamble = _recording_facts(duration_seconds, speaker_count)
            if entities:
                preamble += (
                    "These were named in the meeting. Carry the ones that "
                    "carry meaning into the notes, spelled as they are here, "
                    "and ignore any that turn out to be incidental:\n"
                    + ", ".join(entities)
                    + "\n\n"
                )
            data = await self._chat_json(system, f"{preamble}Transcript:\n{transcript}")
            return _assemble(tpl, data)

        return await _with_retries(
            _op,
            attempts=self._settings.openai_max_retries + 1,
            fallback=SummaryResponse(
                short_summary="", detailed_summary="", key_points=[], template_slug=tpl.slug
            ),
            label="summarize",
        )

    async def extract_action_items(
        self, transcript: str, language: str = "en"
    ) -> list[ActionItem]:
        async def _op() -> list[ActionItem]:
            # Defined because, left undefined,
            # "action item" reads as a formally minuted task, and a meeting
            # where people simply said what they would do yields nothing.
            user = (
                "Extract action items as JSON: "
                '{"actionItems":[{"taskTitle","ownerName","dueDate","priority"'
                '(high|medium|low),"sourceSentence"}]}. '
                "Use null for unknown owner/dueDate.\n\n"
                "An action item is anything someone undertook to do, was asked "
                "to do, or was assigned. It counts however casually it was "
                "said — 'I'll chase them tomorrow', 'can you comment on the "
                "issue', 'I'm going to ping you on this', 'we should add X' — "
                "and whether or not an owner or a date was given.\n"
                "`taskTitle` states the task itself, understandable without "
                "the transcript, and does NOT contain the owner's name.\n"
                "`ownerName` is whoever is on the hook. Fill it whenever the "
                "transcript shows who that is: someone addressed by name for "
                "the task ('I'm going to ping you on this, Cormac' -> Cormac), "
                "someone who volunteered ('I'll chase them tomorrow' -> that "
                "speaker, when the line is attributed), or someone asked "
                "directly ('Samia, can you...'). Use null only when the "
                "transcript genuinely does not show who took it on — an owner "
                "the transcript names is not a guess.\n"
                "`dueDate` is whatever timing was said, in the words used "
                "('Tuesday', 'end of day'), or null.\n"
                "Exclude things already finished, hypotheticals nobody took "
                "on, and social plans unrelated to the work — a film to watch "
                "or a lunch to book is not an action item however sincerely it "
                "was promised."
                "\n\nTranscript:\n" + transcript
            )
            data = await self._chat_json(
                _EXTRACTION_SYSTEM + _language_instruction(language),
                user,
            )
            return [ActionItem.model_validate(x) for x in data.get("actionItems", [])]

        return await _with_retries(
            _op,
            attempts=self._settings.openai_max_retries + 1,
            fallback=[],
            label="extract_action_items",
        )

    # Asked for a lookup. Concise is right here: "what did we decide about
    # pricing?" wants a sentence, not the pricing section reproduced.
    # The brief lives in app/answering.py. It moved out of here when it grew
    # from four sentences into a policy — answer-first, no retrieval narration,
    # no clarifying question when a reasonable answer exists — because it is now
    # the thing most worth reviewing on its own, and because the mock adapter
    # and the tests need to read the same rules this does.

    async def answer(
        self,
        question: str,
        context: list[str],
        *,
        exhaustive: bool = False,
        intent: str = "fact",
        depth: str = "express",
        history: list[str] | None = None,
        policy: str = Knowledge.MEETING_ONLY,
    ) -> Answer:
        async def _op() -> Answer:
            data = await self._chat_json(
                answering.system_prompt(
                    intent=intent, depth=depth, exhaustive=exhaustive,
                    policy=policy,
                ),
                answering.user_prompt(question, context, history),
            )
            return answering.parse(data, len(context))

        return await _with_retries(
            _op,
            attempts=self._settings.openai_max_retries + 1,
            fallback=Answer(text="I couldn't reach the model to answer that right now."),
            label="answer",
        )

    # How many questions to generate. The chat shows three of them at a time —
    # a fourth on screen pushes the composer down and starts reading as a menu
    # the reader must choose from — and rotates through the rest, so opening
    # the same meeting twice does not offer the same three chips twice.
    #
    # Eight rather than three because the pool is free: one call either way,
    # and the alternative way to make chips change is to generate three fresh
    # ones per visit, which is a model call every time somebody opens a page.
    _SUGGESTION_POOL = 8

    # Longest a chip can be before it wraps and stops being scannable. Enforced
    # in the prompt and again on the way out, because the model treats a length
    # limit as advice.
    _SUGGESTION_MAX_CHARS = 80

    _SUGGEST_RULES = (
        "Rules:\n"
        "- Each question must be answerable FROM THIS MATERIAL. A question the "
        "material cannot answer produces a confident wrong reply, which is "
        "worse than offering nothing.\n"
        "- Be specific. Name the actual thing — the product, the customer, the "
        "number, the document. 'What was discussed?' is useless on every "
        "meeting ever recorded, and a chip that could sit on any meeting will "
        "stop being read after the second one.\n"
        f"- Under {_SUGGESTION_MAX_CHARS} characters each. They render as "
        "chips.\n"
        "- No two questions about the same thing.\n"
        "- Return fewer, or none, if the material is too thin to ask anything "
        "specific about. An empty list is a valid answer.\n"
        'Respond with JSON: {"questions": ["...", "..."]}'
    )

    # Home, with nothing selected. The old brief here asked for questions that
    # "refer to real meetings and real topics by name", which is right for a
    # meeting and wrong for an archive: it turns whichever call happened to be
    # most recent into the entry point for everything the user owns.
    _WORKSPACE_SYSTEM = (
        "You suggest starter questions for someone opening their whole meeting "
        "archive. You are given their recent meetings: titles, dates, summaries "
        "and outstanding commitments.\n"
        "Propose questions about the ARCHIVE, not about one meeting. A good "
        "question here is one whose answer draws on several meetings — what has "
        "recurred, what is still owed, what a position moved on, what is "
        "building up. A question only one of these meetings can answer belongs "
        "on that meeting's own page, not here: the reader may have fifty "
        "meetings and only twelve are in front of you.\n"
        "Name a project or a topic only when it appears in several of the "
        "meetings. One mention is not a theme.\n"
    )

    # Home, with meetings chosen through Add context. Now naming things is
    # right: the reader picked these, so a question about them by name is a
    # question about what they asked for.
    _SELECTION_SYSTEM = (
        "You suggest starter questions for someone who has just selected "
        "specific meetings to ask about. You are given those meetings.\n"
        "Propose questions answerable from THESE meetings and worth asking of "
        "this particular set — where they agree, where they differ, what "
        "carried over between them, what was left open across them. Name the "
        "real topics: the reader chose these deliberately.\n"
    )

    async def suggest_questions(
        self, material: str, *, workspace: bool = False, scope: str = "workspace"
    ) -> list[str]:
        async def _op() -> list[str]:
            if workspace:
                system = (
                    self._SELECTION_SYSTEM
                    if scope == "selection"
                    else self._WORKSPACE_SYSTEM
                ) + self._SUGGEST_RULES
            else:
                system = (
                    "You suggest starter questions for someone who has just "
                    "opened the notes for one meeting. You are given its "
                    "summary.\n"
                    f"Propose {self._SUGGESTION_POOL} questions this reader "
                    "would plausibly want answered — the specifics behind a "
                    "decision, what someone committed to, the detail the "
                    "summary compressed.\n" + self._SUGGEST_RULES
                )
            data = await self._chat_json(system, material)
            raw = data.get("questions") or []
            out: list[str] = []
            for q in raw:
                if not isinstance(q, str):
                    continue
                q = q.strip()
                # Over-long ones are dropped rather than truncated: a chip cut
                # mid-sentence would be sent as a truncated question.
                if q and len(q) <= self._SUGGESTION_MAX_CHARS:
                    out.append(q)
            return out[: self._SUGGESTION_POOL]

        return await _with_retries(
            _op,
            attempts=self._settings.openai_max_retries + 1,
            # Empty rather than a generic set: the caller falls back to its own
            # static prompts, which are better written than anything invented
            # here to fill a gap.
            fallback=[],
            label="suggest_questions",
        )

    async def translate(self, text: str, target_language: str) -> str:
        async def _op() -> str:
            return await self._chat_text(
                f"Translate the user's text into {target_language}. "
                "Preserve meaning, tone, names, and formatting. Output only the translation.",
                text,
            )

        return await _with_retries(
            _op,
            attempts=self._settings.openai_max_retries + 1,
            fallback=text,
            label="translate",
        )

    async def translate_lines(
        self, lines: list[str], target_language: str
    ) -> list[str]:
        """Translate a list, preserving its length above all else.

        Chunked, because a two-hour transcript is thousands of utterances and no
        single request survives that. Each chunk is validated on its own and
        falls back to its own source lines, so one badly-behaved chunk costs a
        paragraph of untranslated text rather than the whole transcript.
        """
        if not lines:
            return []

        out: list[str] = []
        for chunk in _chunk_lines(lines):
            out.extend(await self._translate_chunk(chunk, target_language))
        return out

    async def _translate_chunk(
        self, chunk: list[str], target_language: str
    ) -> list[str]:
        # Indexed rather than positional: asking for a JSON object keyed by the
        # line number means a dropped line is a missing key we can fill from the
        # source, instead of a silent shift of everything after it.
        numbered = "\n".join(f"{i} {line}" for i, line in enumerate(chunk))
        system = (
            f"Translate each numbered line into {target_language}. "
            'Reply with JSON: {"lines": {"0": "...", "1": "..."}} — one entry per '
            "input line, keyed by the same number. Translate every line, including "
            "short ones. Never merge, split, reorder or omit lines. Keep names, "
            "product names and numbers as they are. If a line is already in "
            f"{target_language} or cannot be translated, repeat it unchanged."
        )

        async def _op() -> list[str]:
            data = await self._chat_json(system, numbered)
            translated = data.get("lines") or {}
            if isinstance(translated, list):
                # Accepted as well as the keyed form: the length is what matters,
                # and a model that returns the array is not wrong, only literal.
                if len(translated) != len(chunk):
                    raise ValueError(
                        f"expected {len(chunk)} lines, got {len(translated)}"
                    )
                return [str(v) if str(v).strip() else src
                        for v, src in zip(translated, chunk)]
            if not isinstance(translated, dict):
                raise ValueError("translate_lines returned neither an object nor a list")
            # Missing keys keep their source text. Partial is a real outcome and
            # a much better one than a chunk of the wrong speaker's words.
            return [
                str(translated.get(str(i)) or "").strip() or chunk[i]
                for i in range(len(chunk))
            ]

        return await _with_retries(
            _op,
            attempts=self._settings.openai_max_retries + 1,
            fallback=list(chunk),
            label="translate_lines",
        )


    async def draft_followup_email(self, brief: DraftEmailRequest) -> DraftEmailResponse:
        async def _op() -> DraftEmailResponse:
            system = (
                "You write the follow-up email a participant sends after a meeting. "
                "Use ONLY the supplied brief: never invent an owner, a date or a "
                "task that is not listed — the sender will forward "
                "this without checking it line by line. Write in plain professional "
                "prose, no marketing tone, no filler. Keep it under 200 words. Lead "
                "with what came out of the meeting, then who is doing what. Omit any section the "
                "brief has nothing for rather than padding it. Respond with a single "
                'JSON object: {"subject","body"}.'
            )
            parts = [f"Meeting: {brief.title}"]
            if brief.short_summary:
                parts.append(f"Summary: {brief.short_summary}")
            if brief.action_items:
                parts.append("Action items:\n" + "\n".join(f"- {a}" for a in brief.action_items))
            if brief.key_points:
                parts.append("Key points:\n" + "\n".join(f"- {k}" for k in brief.key_points))
            if brief.tone:
                parts.append(f"Additional instruction: {brief.tone}")
            data = await self._chat_json(system, "\n\n".join(parts))
            return DraftEmailResponse(
                subject=str(data.get("subject", f"Recap: {brief.title}")),
                body=str(data.get("body", "")),
            )

        return await _with_retries(
            _op,
            attempts=self._settings.openai_max_retries + 1,
            # An empty draft is honest; a fabricated one gets forwarded.
            fallback=DraftEmailResponse(subject=f"Recap: {brief.title}", body=""),
            label="draft_followup_email",
        )




class OpenAiEmbeddingAdapter(EmbeddingPort):
    """text-embedding-3-small (1536-dim) via the OpenAI SDK."""

    def __init__(self, settings: Settings, client: AsyncOpenAI | None = None) -> None:
        self._settings = settings
        self._client = client or AsyncOpenAI(
            api_key=settings.openai_api_key,
            timeout=settings.openai_timeout_seconds,
            max_retries=0,
        )

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []

        async def _op() -> list[list[float]]:
            resp: Any = await self._client.embeddings.create(
                model=self._settings.openai_embed_model,
                input=texts,
            )
            return [list(d.embedding) for d in resp.data]

        # Fallback: zero-ish unit vectors so retrieval degrades rather than 500s.
        fallback = [[1.0] + [0.0] * (self._settings.embed_dim - 1) for _ in texts]
        return await _with_retries(
            _op,
            attempts=self._settings.openai_max_retries + 1,
            fallback=fallback,
            label="embed",
        )
