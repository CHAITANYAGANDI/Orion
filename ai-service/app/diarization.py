"""Who said it: provider clustering in, meeting-local speaker numbering out.

Two bugs live here, and they are the same bug seen from two ends — Orion
treated the provider's speaker label as if it were a Orion speaker number.

## Bug one: a short interjection got swallowed

    Speaker 1: We need to finish authentication ... exactly ... then deploy.

instead of the three turns that were actually spoken. The provider's *word*
records carry a speaker each; Orion read only the label on the parent
utterance and threw the word-level ones away, so a speaker change inside an
utterance had nowhere to be expressed. `segments_from_utterances` now splits on
the word-level attribution and keeps the utterance whole when the words agree.

## Bug two: the second person to speak was "Speaker 4"

AssemblyAI names voices "A", "B", "C"… and Orion rendered them by alphabet
position — `ord(label) - ord("A") + 1`. A meeting whose two voices clustered as
A and D displayed **Speaker 1 and Speaker 4**, with no Speaker 2 or 3 anywhere,
which reads as two people missing from the room.

Those letters are cluster identifiers. Their ordering and their gaps carry no
meaning about the meeting: which letter a voice lands on depends on the
provider's internal clustering, and "D" does not mean "the fourth person". So
they are not display numbers, and `CanonicalSpeakers` is the translation —
numbering by **first chronological appearance**, meeting-locally:

    provider  A  A  D  D  A  F
    canonical 1  1  2  2  1  3

## Why the raw label is kept anyway

Renumbering is a presentation decision and it is lossy, so the raw token stays
on the segment and on every word. It is what reconciles a provider correction
against what is already on screen, what makes a diarization mistake diagnosable
after the fact (§30's trace answers "did the provider say B and we drew A?"),
and what any future speaker-identification work has to match against. Discarding
it would leave "the transcript says Speaker 2" with nothing behind it.

## What this deliberately does not do

Nothing here infers a speaker from the words. No pause-length rule, no
"short replies belong to the other person", no LLM asked who is talking.
Diarization is acoustic, and a heuristic that reads well in a demo invents
speakers in a real meeting — which is worse than the provider's own mistake,
because it is confident and it is ours. Every boundary drawn here traces back to
an explicit provider attribution, and where the provider declines to attribute,
so does Orion.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Literal, Sequence

Attribution = Literal["attributed", "unknown"]

#: Shown when the provider would not say who spoke. Not a speaker number, on
#: purpose: a turn filed under Speaker 1 because nothing better was known is a
#: quotation beside a name that may never have said it, and that misattribution
#: travels into summaries, action-item owners and exports.
UNKNOWN_SPEAKER = "Unknown speaker"

#: Tokens that look like a label but are the provider declining to answer.
#: "PENDING" is the live stream's placeholder while clustering catches up —
#: observed on the wire, absent from the docs — and it used to reach the UI as
#: a speaker *named* "PENDING", complete with a "PENDING" avatar.
_NOT_A_SPEAKER = {"", "UNKNOWN", "UNK", "?", "NONE", "NULL", "PENDING", "SPEAKER"}


@dataclass(frozen=True)
class SpeakerIdentity:
    """One voice, in all three of the vocabularies that have to coexist.

    `raw` is the provider's, `key` is Orion's stable internal handle, and
    `label` is the one a person reads. They are separate because they change on
    different schedules: a rename replaces the label and must not disturb the
    key (which is what a colour is picked from), and a provider correction
    replaces the raw token without meaning the person changed.
    """

    #: The provider's own token ("A", "3"), or None where it gave nothing usable.
    raw: str | None
    #: Meeting-local and stable across renames: "spk_1". None when unattributed.
    key: str | None
    #: What the transcript shows: "Speaker 2", or UNKNOWN_SPEAKER.
    label: str
    status: Attribution


#: The identity used for anything the provider would not attribute. Shared
#: rather than rebuilt so that every unattributed turn compares equal.
UNATTRIBUTED = SpeakerIdentity(raw=None, key=None, label=UNKNOWN_SPEAKER, status="unknown")


def is_generic_cluster(token: str) -> bool:
    """True for a provider cluster id, false for something that is a name.

    The distinction decides what gets displayed. A cluster id ("A", "0",
    "channel:1") carries no meaning and is replaced by a meeting-local number;
    anything else came from speaker identification and is a name, which beats
    any number Orion could invent. Users renaming a speaker themselves sit
    above both, and that happens later and elsewhere -- this only chooses
    between the provider's two kinds of answer.
    """
    return len(token) == 1 or token.isdigit() or token.startswith("channel:")


def raw_token(value: Any, *, channel: Any = None) -> str | None:
    """The provider's identifier for a voice, or None if there isn't one.

    Normalising only — this deliberately assigns no number. Letter labels are
    upper-cased so that "a" and "A" are one voice; everything else is kept
    verbatim, because a provider that returns a real name from speaker
    identification is telling us something a number cannot.

    `channel` is consulted only when the caller has vouched that the file is
    channel-separated. A stereo recording of a room has everyone on both
    channels, and reading channels as speakers there invents a second person out
    of the room's own echo.
    """
    if isinstance(value, str):
        token = value.strip()
        if token.upper() in _NOT_A_SPEAKER:
            return None
        if token:
            # Single letters are the provider's cluster ids and are
            # case-insensitive; longer strings may be real names, so they are
            # left exactly as given.
            return token.upper() if len(token) == 1 and token.isalpha() else token
    # bool is an int in Python, and `True` is not speaker 2.
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)

    if isinstance(channel, int) and not isinstance(channel, bool):
        return f"channel:{channel}"
    if isinstance(channel, str) and channel.strip().isdigit():
        return f"channel:{channel.strip()}"
    return None


class CanonicalSpeakers:
    """Meeting-local speaker numbering, by order of first appearance.

    One instance per transcript. Feed it raw provider tokens in the order the
    words were spoken and it hands back stable identities:

        >>> speakers = CanonicalSpeakers()
        >>> speakers.resolve("D").label
        'Speaker 1'
        >>> speakers.resolve("A").label
        'Speaker 2'
        >>> speakers.resolve("D").label
        'Speaker 1'

    Deterministic by construction: the mapping is a function of the order it is
    asked, nothing is sorted, and no clock or hash is involved — so reprocessing
    the same provider response produces the same numbering. Callers must
    therefore feed it in chronological order, which is why the parsers sort
    before they resolve rather than after.

    An unattributed voice does **not** consume a number. If it did, one
    unlabelled turn early in a meeting would shift every subsequent speaker by
    one, and the transcript would name people who were never identified.
    """

    def __init__(self) -> None:
        self._by_raw: dict[str, SpeakerIdentity] = {}

    def resolve(self, value: Any, *, channel: Any = None) -> SpeakerIdentity:
        """Identity for a provider label, assigning the next number if it is new."""
        return self.for_token(raw_token(value, channel=channel))

    def for_token(self, token: str | None) -> SpeakerIdentity:
        """As `resolve`, for a token already normalised by `raw_token`."""
        if token is None:
            return UNATTRIBUTED
        known = self._by_raw.get(token)
        if known is not None:
            return known
        number = len(self._by_raw) + 1
        identity = SpeakerIdentity(
            raw=token,
            key=f"spk_{number}",
            # A real name outranks a generic number -- see the hierarchy in
            # `is_generic_cluster`. The ordinal is still spent on them, so
            # "Cindy" is spk_1 and the next unnamed voice is Speaker 2 rather
            # than colliding with her.
            label=f"Speaker {number}" if is_generic_cluster(token) else token,
            status="attributed",
        )
        self._by_raw[token] = identity
        return identity

    @property
    def count(self) -> int:
        """How many distinct voices have been attributed so far."""
        return len(self._by_raw)

    def mapping(self) -> dict[str, str]:
        """raw token -> display label. For diagnostics and the §30 trace."""
        return {raw: identity.label for raw, identity in self._by_raw.items()}


# --------------------------------------------------------------------------- #
# Word-level segmentation
# --------------------------------------------------------------------------- #


@dataclass
class SpokenWord:
    """One word as the provider timed and attributed it.

    A neutral shape so this module does not depend on any one adapter's schema;
    each adapter converts into it and back out. `speaker` is the **raw**
    provider token — canonicalisation happens once, here, rather than in each
    adapter, which is how the two of them came to disagree in the first place.
    """

    text: str
    start: float
    end: float
    confidence: float | None = None
    speaker: str | None = None


@dataclass
class SpeakerRun:
    """A stretch of consecutive words the provider gave to one voice."""

    identity: SpeakerIdentity
    words: list[SpokenWord] = field(default_factory=list)
    #: True when this run is part of an utterance that was split, i.e. it does
    #: not begin where the provider's own sentence began. Only used to decide
    #: capitalisation of the fragment.
    split: bool = False

    @property
    def start(self) -> float:
        return self.words[0].start if self.words else 0.0

    @property
    def end(self) -> float:
        return self.words[-1].end if self.words else 0.0


def split_by_speaker(
    words: Sequence[SpokenWord], speakers: CanonicalSpeakers
) -> list[SpeakerRun]:
    """Break a word sequence wherever the provider changes its attribution.

        A A A A B A A A   ->   [A…], [B], [A…]

    The one-word B run in the middle is the entire point. It is a real turn —
    "Exactly.", "I agree." — and merging it into either neighbour puts words in
    somebody's mouth. Nothing here merges on length, and nothing splits on
    anything but an explicit change of provider label.

    A word the provider did not attribute continues the run it is in rather than
    starting an unattributed island: the provider labels words it is confident
    about and leaves gaps mid-utterance, and honouring every gap would shred a
    sentence into alternating known and unknown fragments. A gap at the *start*
    of a run is a genuine unknown and is kept as one.
    """
    runs: list[SpeakerRun] = []
    for word in words:
        token = raw_token(word.speaker)
        current = runs[-1] if runs else None

        if current is not None and (token is None or token == current.identity.raw):
            current.words.append(word)
            continue

        identity = speakers.for_token(token)
        runs.append(SpeakerRun(identity=identity, words=[word], split=bool(runs)))
    return runs


def join_words(words: Iterable[SpokenWord], *, capitalise: bool = False) -> str:
    """Render words as a line, without mangling the provider's punctuation.

    The provider attaches punctuation to the word it belongs to ("Exactly.",
    "Yes,"), so joining with spaces is almost always right. The exception is a
    token that is *only* punctuation, which some providers emit separately and
    which a plain join would push out to its own island:

        "Let's ship Friday" + "," + "if QA passes"  ->  "Let's ship Friday, if QA passes"

    `capitalise` is for a fragment that begins mid-sentence because the words
    before it turned out to belong to someone else. Leaving it lowercase reads
    as a broken sentence rather than as a turn. It is a single leading character
    and it is skipped for words with an interior capital — "iPhone" must not
    become "IPhone".
    """
    out = ""
    for word in words:
        text = word.text.strip()
        if not text:
            continue
        if out and not _is_trailing_punctuation(text):
            out += " "
        out += text
    if capitalise and out:
        out = _sentence_case(out)
    return out


def _is_trailing_punctuation(text: str) -> bool:
    """A token that belongs to the previous word rather than beside it."""
    return all(not ch.isalnum() for ch in text) and text[0] in ",.;:!?)]}'\"…%"


def _sentence_case(text: str) -> str:
    first = text[0]
    if not first.islower():
        return text
    # "iPhone", "eBay" — an interior capital means the lower-case start is the
    # spelling, not a mid-sentence position.
    head = text.split(" ", 1)[0]
    if any(ch.isupper() for ch in head[1:]):
        return text
    return first.upper() + text[1:]


def trace_lines(segments: Sequence[Any]) -> list[str]:
    """The §30 diarization trace: one line per word, raw beside canonical.

        00:10.20  "we"       raw=A  canonical=Speaker 1
        00:11.02  "exactly"  raw=D  canonical=Speaker 2

    This is the view that settles whose bug it is. If the provider said B and
    the canonical column says Speaker 1, the fault is in this file; if the
    provider itself said A, no amount of remapping here will fix it and the
    answer is expected-speaker constraints or better audio.

    Transcript content, so it is developer-only — see the caller's gate. It is
    never emitted by default and never sent to telemetry.
    """
    lines: list[str] = []
    for segment in segments:
        for word in getattr(segment, "words", []) or []:
            raw = getattr(word, "speaker_raw", None) or "-"
            canonical = getattr(word, "speaker", None) or UNKNOWN_SPEAKER
            lines.append(
                f'{_stamp(getattr(word, "start", 0.0))}  '
                f'"{getattr(word, "text", "")}"  raw={raw}  canonical={canonical}'
            )
    return lines


def _stamp(seconds: float) -> str:
    minutes, rest = divmod(max(0.0, float(seconds)), 60)
    return f"{int(minutes):02d}:{rest:05.2f}"
