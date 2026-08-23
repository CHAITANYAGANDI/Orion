"""What the transcriber is about to hear, in the words it accepts.

Speech models guess. Given "sprint review" and the name of the project
beforehand, they guess differently — and the words a meeting app gets wrong
are exactly the ones a generic language model has never seen: product names,
acronyms, the client. Recallix already knows some of them at the moment it
queues a job and, before this module existed, sent none of them.

This module once had two more sources: the account's custom vocabulary and its
known speakers. Both features were removed, and with them the only inputs that
named people or jargon. What is left is the meeting's own title, project and
type, which is enough for the prose prompt and close to nothing for keyterms
— see :func:`build_keyterms`.

Two channels, because AssemblyAI has two and they do different jobs:

``prompt``
    Prose. Sets the domain so the model's language model leans the right way —
    "deploy" over "the ploy", "Kafka" over "coffee". Kept to a sentence or two;
    the provider accepts far more, but its own guidance tops out around fifty
    words and a prompt that recites the whole meeting is a prompt that says
    nothing in particular.

``keyterms_prompt``
    A list. Names the exact strings to get right.

**This is context, never instruction.** Nothing here asks for a summary, a
format, or a judgement — a transcription prompt that says "write clearly" is
asking a speech model to stop transcribing and start editing, and the words it
invents are indistinguishable from the words that were said.

Deterministic on purpose: same meeting in, same strings out. A prompt built
from a set iteration order or a dict ordering would make two runs of the same
recording differ for reasons nobody could see, which is the one thing a
benchmark cannot tolerate.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# AssemblyAI's documented ceilings, verified against the live API.
#
# The 1000 figure is for universal-3.5-pro; universal-2 stops at 200. The
# adapter picks which applies from the model it is actually about to ask for,
# because sending 1000 terms to a job that falls back to universal-2 is how a
# request gets refused for a reason nobody logged.
KEYTERMS_MAX_UNIVERSAL_3 = 1000
KEYTERMS_MAX_UNIVERSAL_2 = 200
#: "maximum 6 words per phrase" — longer entries are dropped, not truncated.
KEYTERM_MAX_WORDS = 6
#: Nothing useful is one character, and single letters match everything.
KEYTERM_MIN_CHARS = 2

#: The provider allows 1500 words. Its own guidance calls 20–50 "detailed", and
#: past that a prompt stops describing a meeting and starts being one.
PROMPT_MAX_WORDS = 50


@dataclass(frozen=True)
class MeetingContext:
    """What Recallix knows about a recording before it has heard it.

    Every field is optional and every one is routinely absent — an imported
    file has no project, a quick recording has no title. The builder is written
    so that the empty case produces no prompt at all rather than a sentence made
    of commas.
    """

    title: str | None = None
    project: str | None = None
    #: The summary template's human name — "Engineering sprint review", "1:1".
    meeting_type: str | None = None
    #: Companies, clients, products. Nothing populates this today: it is the
    #: last remaining source of keyterms, and the enqueue path sends it empty.
    organisations: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class TranscriptionContext:
    """The two strings a provider can be given, and nothing else."""

    prompt: str | None = None
    keyterms: list[str] = field(default_factory=list)


_TITLE_NOISE = re.compile(
    r"""^(
        recording           # the date-stamped default from the record bar
        |untitled
        |new\s+meeting
        |audio
        |meeting
    )\b""",
    re.IGNORECASE | re.VERBOSE,
)

#: `recording-1755084000000.webm`, `Zoom_0.mp4`, `GMT20260819-audio`.
_FILENAMEISH = re.compile(r"^[\w.\-]+\.(webm|mp4|m4a|mp3|wav|ogg|flac)$", re.IGNORECASE)


def _clean(value: str | None) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def meaningful_title(title: str | None) -> str | None:
    """A title worth telling the transcriber, or None.

    "Recording — 19/08/2026, 21:15" is the name Recallix gives a recording
    nobody named. Putting it in a prompt teaches the model that this meeting is
    about recordings and dates, which is worse than saying nothing: an empty
    prompt is ignored, a misleading one is obeyed.
    """
    text = _clean(title)
    if not text or len(text) < 3:
        return None
    if _FILENAMEISH.match(text):
        return None
    if _TITLE_NOISE.match(text):
        return None
    # A name that is mostly digits and punctuation is a timestamp wearing a
    # title's clothes.
    letters = sum(ch.isalpha() for ch in text)
    if letters < max(3, len(text) // 3):
        return None
    return text


def _series(items: list[str]) -> str:
    """`a`, `a and b`, `a, b and c` — a sentence, because the prompt is prose."""
    if len(items) == 1:
        return items[0]
    return f"{', '.join(items[:-1])} and {items[-1]}"


def build_prompt(context: MeetingContext) -> str | None:
    """One or two sentences of domain, or None when there is nothing to say.

    None rather than an empty string: the adapter omits the field entirely, and
    a provider given `prompt: ""` is being told something different from a
    provider not given a prompt at all.
    """
    subject = _clean(context.meeting_type) or "Meeting"
    title = meaningful_title(context.title)
    project = _clean(context.project)

    head = subject
    if title:
        head = f"{subject}: {title}" if subject.lower() not in title.lower() else title
    if project:
        head = f"{head} (project {project})"

    # Terms worth naming in prose. Organisations are what is left of this: the
    # user's own vocabulary and the participant list both went with the
    # features that filled them.
    topics = _dedupe(context.organisations)[:8]

    parts = [f"{head}."]
    if topics:
        parts.append(f"Discussion involves {_series(topics)}.")

    # Nothing but the bare default means nothing was known. "Meeting." as a
    # prompt is noise with a full stop on it.
    if len(parts) == 1 and not title and not project and not _clean(context.meeting_type):
        return None

    return _cap_words(" ".join(parts), PROMPT_MAX_WORDS)


def _cap_words(text: str, limit: int) -> str:
    words = text.split()
    if len(words) <= limit:
        return text
    # Cut on a word and close the sentence, so the model is never handed a
    # fragment ending mid-name.
    return " ".join(words[:limit]).rstrip(",;:") + "."


def _dedupe(values: list[str]) -> list[str]:
    """Case-insensitive, first spelling wins, order preserved.

    First spelling rather than last because the earlier sources are the more
    authoritative ones.
    """
    out: list[str] = []
    seen: set[str] = set()
    for raw in values:
        term = _clean(raw)
        if not term:
            continue
        key = term.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(term)
    return out


def build_keyterms(
    context: MeetingContext,
    *,
    limit: int = KEYTERMS_MAX_UNIVERSAL_3,
) -> list[str]:
    """The exact strings to get right, in priority order.

    Ordered rather than merged arbitrarily, because the limit truncates: when
    there are more terms than the provider accepts, the ones that survive
    should be the ones a wrong guess is most visible on.

    Terms too long for the provider are **dropped rather than truncated**. Half
    a phrase is a different phrase, and biasing the model toward it is worse
    than not biasing it at all.

    **This returns nothing today, and that is honest rather than broken.** Its
    two real sources were the account's custom vocabulary and its known
    speakers; both features are gone. ``organisations`` remains as the input a
    future feature would fill, and the enqueue path sends it empty — so the
    adapters below send no boosting field at all, which is what they already did
    for every account that never added a term.
    """
    ordered = _dedupe(list(context.organisations))

    out: list[str] = []
    for term in ordered:
        if len(term) < KEYTERM_MIN_CHARS:
            continue
        if len(term.split()) > KEYTERM_MAX_WORDS:
            continue
        out.append(term)
        if len(out) >= max(0, limit):
            break
    return out


class TranscriptionContextBuilder:
    """Builds both channels from one meeting, under one provider's limits.

    A class rather than two free functions because the limits move together:
    the keyterm ceiling depends on which model the adapter is about to ask for,
    and it would be easy to change one call site and not the other.
    """

    def __init__(self, *, keyterms_limit: int = KEYTERMS_MAX_UNIVERSAL_3) -> None:
        if keyterms_limit < 0:
            raise ValueError("keyterms_limit cannot be negative")
        self._limit = keyterms_limit

    def build(self, context: MeetingContext | None) -> TranscriptionContext:
        ctx = context or MeetingContext()
        return TranscriptionContext(
            prompt=build_prompt(ctx),
            keyterms=build_keyterms(ctx, limit=self._limit),
        )
