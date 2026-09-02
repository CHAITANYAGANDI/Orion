"""Names people call each other by, read off the dialogue.

A meeting opens *"Hi, how are you Michael?"* and the reply is *"I'm good,
Charles."* — and every reader of that transcript knows who is who, while
Reverie prints **Speaker 1** and **Speaker 2** over the top of it. This module
is the part that reads what a reader reads.

It is a different question from the one
[speaker-identification](../../docs/speaker-identification.md) answers, and the
distinction is the whole justification for it existing. That feature asks
*whose voice is this?* and answers acoustically, because the words cannot answer
it. This one asks *did the conversation say who these people are?* — a question
**about the words**, which is the only kind of question the words are evidence
for. §2 of that document rules out "reading the transcript" as a way of
recognising a voice across meetings, and that ruling stands: nothing here
compares anybody to anybody, nothing here is written to a profile, and a name
found here never becomes evidence about any other recording.

<h2>The direction, which is the entire bug waiting to happen</h2>

A name in a turn is almost never the name of the person saying it.

    Speaker 1:  Hi, how are you Michael?      <- Michael is SPEAKER 2
    Speaker 2:  I'm good, Charles.            <- Charles is SPEAKER 1

Getting this backwards is not a subtle failure. It swaps two people across an
entire transcript, and every downstream artefact — the summary, the retrieval
passages, the export, the quotations with names under them — carries the swap
with total confidence. So the direction is not inferred from the prose; it is a
required field on every claim (``basis``), and it is checked here against who
actually holds the turn:

* ``addressed``   — somebody said the name **to** them. The named speaker must
  therefore be somebody *other* than the speaker of the evidence turn.
* ``introduced``  — they said their own name ("I'm Michael", "Michael here").
  The named speaker must be the speaker of the evidence turn.

A claim whose direction does not line up with the transcript is dropped rather
than flipped. A model that got the direction wrong was not reading carefully,
and the fix for that is not to trust the rest of what it said.

<h2>Why the model's answer is checked rather than applied</h2>

Same reasoning as ``app.quotes``, for the same reason: a model asked who these
people are will answer, fluently, whether or not the transcript says. So every
claim has to point at text — a ``quote``, and a turn number it came from — and
the checks below are arithmetic on the transcript rather than opinions about the
answer:

1. the quote really appears in that turn (normalised for the punctuation models
   rewrite, never fuzzy — a paraphrase must fail or the check is theatre);
2. the name really appears in the quote, so the evidence contains the thing it
   is evidence for;
3. the direction matches who spoke (above);
4. for ``addressed``, the named speaker is **actually nearby** — they hold a
   turn within two runs of the evidence. You are addressed by someone who is in
   the conversation with you, so *"Michael, can you take this?"* followed by
   somebody else answering is not evidence about the person who eventually
   spoke. In a two-person meeting this is satisfied by construction, which is
   correct: with two voices, "not the one talking" is the other one;
5. the name is being spoken **to** somebody rather than merely mentioned.
   *"Michael said he'd handle it"*, *"Michael's numbers"* and *"Chaitanya will
   finish it by Friday"* all name a person who may not be in the room at all,
   and the last of those is how work is actually handed out in a meeting. A
   name carrying a reporting verb, a third-person pronoun or a possessive is
   the subject of its sentence and is refused;
6. the name is name-shaped, and is not a form of address that is not a name —
   "everyone", "guys", "sir". These are the false positives that would
   otherwise show a transcript spoken by somebody called **Mate**;
7. nobody is renamed to something a person already carries in this meeting.

<h2>Ties refuse</h2>

Two different names for one speaker are resolved by weight of evidence — five
turns addressing them as Michael and one as Mike is not a contradiction, it is a
nickname — and refuse outright when the support is equal. This mirrors the
*margin* rule in ``app.voiceprints``: when the best answer is not distinctly the
best, the honest answer is none.

One name claimed for **two** speakers refuses both, with no margin. That
collision is the signature of a third-person mention leaking in ("Michael said
he'd handle it"), and unlike the nickname case the two candidates are not two
descriptions of one person — they are two people, one of whom is about to be
given the other's name.

<h2>What it will not touch</h2>

Anything that already has a name — typed by the user, resolved by an earlier
rematch, or returned by the provider's own speaker identification — and any turn
the provider declined to attribute at all. Both guards are
``app.voiceprints.is_unresolved`` and the ``unknown`` status, the same two used
by acoustic matching, so there is one definition of "still a placeholder" in the
service rather than two that can drift.

Nothing here is fatal. A meeting whose speakers cannot be named is a meeting
with Speaker 1 and Speaker 2 in it, which is exactly where it started.
"""

from __future__ import annotations

import logging
import re

from app.quotes import normalise
from app.voiceprints import is_unresolved

logger = logging.getLogger("ai-service.naming")

#: How far from the evidence an addressed speaker may be, counted in *runs* of
#: consecutive turns by one voice rather than in turns.
#:
#: Runs, because a segment boundary is a pause in the audio and not a change of
#: subject: somebody who says three sentences in a row occupies three turns, and
#: measuring in turns would put the person they just greeted "four away" for no
#: reason a reader would recognise. Two runs either side covers the shapes that
#: are real evidence — the reply, the hand-off, being thanked for what you just
#: said — and excludes a name called out at the top of a meeting by somebody who
#: then talked for ten minutes.
NEIGHBOUR_RUNS = 2

#: Longest a name may be, in words. Enough for "Mary Jane" or "Van Der Berg",
#: short enough that a clause the model mistook for a name cannot get through.
MAX_NAME_WORDS = 3

#: And in characters, against a single very long token.
MAX_NAME_CHARS = 40

#: A name is letters, and the punctuation that appears inside real names.
#: Digits are excluded deliberately: "Speaker 2" and "Interviewer 2" are labels
#: about a transcript, not people, and nobody is called them.
_NAME_SHAPE = re.compile(r"^[^\W\d_][\w'’.\- ]*$", re.UNICODE)

#: Ways of addressing somebody that are not their name.
#:
#: Every one of these is a real vocative — they appear in exactly the position a
#: name appears in, right where the checks above are looking — and every one of
#: them would render as a person. "Thanks, mate" is not somebody called Mate.
#:
#: Deliberately a closed list of forms of address rather than a general
#: "is this a name?" test. The clever version has to decide whether "Faith",
#: "Grace" or "Sunny" is a person, and it will sometimes decide wrong about
#: somebody's actual name, which is a worse failure than the one it prevents.
_NOT_A_NAME = frozenset(
    {
        # Groups. The most common false positive by a distance: a meeting is
        # opened by addressing the room, and the room is not a speaker.
        "all", "everybody", "everyone", "folks", "guys", "team", "people",
        "gentlemen", "ladies", "friends", "colleagues", "group", "room",
        # Familiar address.
        "mate", "man", "dude", "buddy", "pal", "bro", "bud", "boss", "chief",
        "honey", "love", "dear", "darling", "sweetie", "kid", "champ",
        # Formal address and titles standing alone.
        "sir", "madam", "ma'am", "miss", "mister", "mr", "mrs", "ms",
        "doctor", "dr", "professor", "prof", "captain", "officer",
        # Greetings and discourse markers that land in the same slot.
        "hi", "hey", "hello", "yes", "yeah", "yep", "no", "nope", "okay", "ok",
        "right", "well", "so", "sure", "thanks", "thank", "please", "sorry",
        "great", "good", "morning", "afternoon", "evening", "night",
        "welcome", "bye", "goodbye", "cheers",
        # Exclamations that are grammatically vocative and never a speaker.
        "god", "jesus", "christ", "lord", "heaven",
        # The product, which is addressed by name in a meeting about it.
        "reverie",
    }
)

#: Words that, following a name, make it the subject of the sentence rather
#: than the person being spoken to.
#:
#: *"Michael said he'd handle it"* names somebody who may not be in the room at
#: all, and is the single most common way a mention gets mistaken for an
#: address. It is caught structurally rather than by asking the model to be
#: careful: a vocative is never followed by a reporting verb or by a pronoun
#: standing in for the same person. "Michael, can you..." and "Michael, will
#: you..." are addresses and are deliberately not on this list — only the forms
#: where the name is unambiguously the grammatical subject.
_THIRD_PERSON_AFTER = frozenset(
    {
        "said", "says", "say", "told", "tells", "mentioned", "mentions",
        "thinks", "thought", "wrote", "sent", "asked", "added", "replied",
        "he", "she", "they", "him", "her", "them", "his", "their", "hers",
        # The possessive, which `app.quotes.normalise` leaves as a bare token:
        # "Michael's numbers" comes through as "michael s numbers". Somebody
        # whose numbers are being discussed is being talked about, not to.
        "s",
    }
)

#: Modals, which go either way and are settled by the word after them.
#:
#: *"Chaitanya will finish the gateway by Friday"* is how work actually gets
#: assigned in a meeting, and it names somebody who may be on holiday. But
#: *"Michael, will you take this?"* is the same modal addressing a person in the
#: room, and the comma that separates them is gone by the time the text is
#: normalised. What separates them reliably is the next word: a second-person
#: pronoun means the sentence turned to face somebody.
_MODAL_AFTER = frozenset(
    {"will", "can", "could", "should", "would", "might", "must", "needs", "wants"}
)

#: What makes a modal an address rather than an assignment.
_SECOND_PERSON = frozenset({"you", "your", "youre", "yours"})


def dialogue(segments) -> str:
    """The turns, numbered, as the model is asked to read them.

    Numbered because a claim has to say *where* it found its evidence, and a
    turn number is the one identifier that survives the round trip unchanged.
    Asking for a timestamp instead would invite an invented one — the model
    never sees the clock — which is the mistake ``app.quotes.locate`` exists to
    avoid on the outline.

    Unattributed turns are included and labelled as such. They are never a
    claim's target, but leaving them out would silently close a gap in the
    conversation and make two turns look adjacent that were not.
    """
    lines = []
    for index, segment in enumerate(_speaking(segments), start=1):
        lines.append(f"{index}. {segment.speaker or 'Unknown speaker'}: {segment.text.strip()}")
    return "\n".join(lines)


def open_labels(segments) -> list[str]:
    """The speaker labels a name is allowed to be attached to.

    Placeholders only, attributed only, in the order they first speak. Handed to
    the model so it is asked about the right people, and enforced again on the
    way back — the wire is not a place to keep a rule.
    """
    seen: list[str] = []
    for segment in _speaking(segments):
        label = segment.speaker
        if not _nameable(segment):
            continue
        if label not in seen:
            seen.append(label)
    return seen


def resolve(claims, segments) -> dict[str, str]:
    """Verified claims in, ``{speaker label: name}`` out.

    Everything a claim asserts is checked against ``segments``; nothing is taken
    on trust and nothing is repaired. Returns an empty mapping freely — most
    meetings do not say anybody's name, and that is not a failure.
    """
    turns = _speaking(segments)
    if not turns:
        return {}

    runs = _runs(turns)
    open_now = set(open_labels(segments))
    # Names already on somebody in this meeting: a provider's speaker
    # identification may have supplied one, or a rematch may have. They are the
    # one set of names nobody else may be given.
    taken = {
        segment.speaker.strip().casefold()
        for segment in turns
        if segment.speaker and not is_unresolved(segment.speaker)
        and segment.speaker_status != "unknown"
    }

    # label -> name -> how many separate turns said so
    support: dict[str, dict[str, int]] = {}
    for claim in claims:
        checked = _check(claim, turns, runs, open_now)
        if checked is None:
            continue
        label, name = checked
        support.setdefault(label, {})[name] = support.setdefault(label, {}).get(name, 0) + 1

    resolved: dict[str, str] = {}
    for label, names in support.items():
        best = _clear_winner(names)
        if best is None:
            logger.info("Speaker naming: %s left alone, the transcript disagrees with itself.", label)
            continue
        if best.casefold() in taken:
            logger.info("Speaker naming: a name found for a speaker is already worn by another.")
            continue
        resolved[label] = best

    return _drop_collisions(resolved)


def apply(segments, names: dict[str, str]) -> list[str]:
    """Write the names onto the turns. Returns the names actually applied.

    <h2>Resolved to canonical keys first, then written by key</h2>

    ``names`` arrives keyed by the label the model was shown, because a label is
    the only identity visible in a transcript. It is **applied** by
    ``speaker_key``, which is the identity that actually owns an utterance —
    the same two-step, for the same reason, as
    ``MeetingService.renameSpeakers``.

    The difference matters even though the two are one-to-one today. Writing by
    label means the string on screen is the lookup key, and a lookup key that
    two speakers can share is one refactor away from merging them. Writing by
    key means a rename is arithmetic on ownership that was decided by the
    provider, and no display name can move an utterance between two people.
    Both passes are over the original labels, so a segment renamed early cannot
    change what a later one matches on.

    Re-guarded rather than trusted: ``_nameable`` runs again here. This is the
    line between "a bad reading of the dialogue" and "overwrote a name a person
    typed", and it costs one comparison to make the second impossible.
    """
    if not names:
        return []

    # Pass one: which canonical speakers the named labels belong to.
    #
    # A label that turns out to cover more than one key is dropped rather than
    # applied to both. Naming both is the merge this whole file exists to
    # prevent — two canonical speakers wearing one name — and naming whichever
    # came first is answering a question the evidence did not settle. Unreachable
    # from `CanonicalSpeakers`, which numbers speakers apart, and the refusal
    # costs nothing where it never happens.
    keys_for: dict[str, set[str]] = {}
    for segment in segments:
        if not _nameable(segment) or not segment.speaker_key:
            continue
        if names.get(segment.speaker) is not None:
            keys_for.setdefault(segment.speaker, set()).add(segment.speaker_key)

    by_key: dict[str, str] = {}
    for label, keys in keys_for.items():
        if len(keys) != 1:
            logger.info("Speaker naming: a label covering %d canonical speakers was left alone.",
                        len(keys))
            continue
        by_key[next(iter(keys))] = names[label]

    # Pass two: write. The key decides where there is one; the label is the
    # fallback only for a transcript recorded before canonical keys existed,
    # where it is the only identity there is.
    applied: list[str] = []
    for segment in segments:
        if not _nameable(segment):
            continue
        name = by_key.get(segment.speaker_key) if segment.speaker_key \
            else names.get(segment.speaker)
        if name is None:
            continue
        segment.speaker = name
        if name not in applied:
            applied.append(name)
    return applied


# --- the checks -----------------------------------------------------------


def _check(claim, turns, runs, open_now) -> tuple[str, str] | None:
    """One claim, or None. Every rejection is a rule, never a judgement."""
    label = (getattr(claim, "speaker", "") or "").strip()
    name = _clean_name(getattr(claim, "name", ""))
    basis = (getattr(claim, "basis", "") or "").strip().lower()
    quote = (getattr(claim, "quote", "") or "").strip()
    index = getattr(claim, "turn", 0)

    if not label or not name or label not in open_now:
        return None
    if basis not in ("addressed", "introduced"):
        return None
    if not isinstance(index, int) or not 1 <= index <= len(turns):
        return None

    evidence = turns[index - 1]
    # The quote has to be in the turn it says it is in, and the name has to be
    # in the quote. Together these mean the model has pointed at the words
    # rather than described them.
    haystack = normalise(evidence.text)
    if not haystack or normalise(quote) not in haystack:
        return None
    at = _locate(name, quote)
    if at is None:
        return None

    spoken_by = (evidence.speaker or "").strip()
    if basis == "introduced":
        # "I'm Michael." Only the person saying it can be named by it.
        return (label, name) if spoken_by == label else None

    # "How are you, Michael?" — said by somebody else, about somebody near.
    if spoken_by == label:
        return None
    if _is_mention(name, quote, at):
        return None
    return (label, name) if _within_reach(label, index - 1, runs) else None


def _locate(name: str, quote: str) -> int | None:
    """Where the name starts in the quote, in whole words, or None.

    Whole words rather than a substring, which is not pedantry: "Ann" is inside
    "announcement" and "Michael" is inside "Michael's" — and the second of those
    is a possessive, which is somebody being talked *about*.
    """
    words = normalise(quote).split()
    wanted = normalise(name).split()
    if not wanted or len(wanted) > len(words):
        return None
    for start in range(len(words) - len(wanted) + 1):
        if words[start:start + len(wanted)] == wanted:
            return start
    return None


def _is_mention(name: str, quote: str, at: int) -> bool:
    """Whether the name is the subject of the sentence rather than its target."""
    words = normalise(quote).split()
    after = at + len(normalise(name).split())
    if after >= len(words):
        return False
    following = words[after]
    if following in _THIRD_PERSON_AFTER:
        return True
    if following in _MODAL_AFTER:
        # "Michael will you" turns to face him; "Michael will finish" does not.
        return after + 1 >= len(words) or words[after + 1] not in _SECOND_PERSON
    return False


def _within_reach(label: str, turn_index: int, runs) -> bool:
    """Whether ``label`` holds a turn close enough to be the one addressed."""
    here = next((i for i, run in enumerate(runs) if turn_index in run.turns), None)
    if here is None:
        return False
    low = max(0, here - NEIGHBOUR_RUNS)
    high = min(len(runs) - 1, here + NEIGHBOUR_RUNS)
    return any(
        runs[i].speaker == label
        for i in range(low, high + 1)
        if i != here
    )


def _clear_winner(names: dict[str, int]) -> str | None:
    """The best-supported name, or None when it is not distinctly the best.

    "Michael" five times beside "Mike" once is a nickname and resolves. One
    each is a contradiction and does not — the same refusal, and the same
    reasoning, as the margin check on voice matching.
    """
    if not names:
        return None
    ranked = sorted(names.items(), key=lambda kv: -kv[1])
    if len(ranked) > 1 and ranked[0][1] == ranked[1][1]:
        return None
    return ranked[0][0]


def _drop_collisions(resolved: dict[str, str]) -> dict[str, str]:
    """Refuse any name that came out attached to more than one speaker.

    No margin and no winner. Two speakers holding one name is what a
    third-person mention looks like from here — *"Michael said he'd handle
    it"* is evidence about somebody who may not even be in the room — and the
    cost of picking one is putting a real person's name on the wrong voice.
    """
    counts: dict[str, int] = {}
    for name in resolved.values():
        counts[name.casefold()] = counts.get(name.casefold(), 0) + 1
    kept = {
        label: name for label, name in resolved.items() if counts[name.casefold()] == 1
    }
    if len(kept) != len(resolved):
        logger.info("Speaker naming: dropped a name claimed for more than one speaker.")
    return kept


def _clean_name(raw: str) -> str:
    """A person's name, or "" for anything that is not one."""
    name = " ".join((raw or "").split()).strip(" .,-")
    if not name or len(name) > MAX_NAME_CHARS or len(name.split()) > MAX_NAME_WORDS:
        return ""
    if not _NAME_SHAPE.match(name):
        return ""
    # "Speaker 2" comes back surprisingly often when the model has nothing.
    if is_unresolved(name):
        return ""
    # Checked per word so "hey guys" and "thanks Michael" both fail on the part
    # that is not a name, rather than passing because the pair is unfamiliar.
    if any(word.strip(".,'’").casefold() in _NOT_A_NAME for word in name.split()):
        return ""
    return name


# --- shapes ---------------------------------------------------------------


class _Run:
    """Consecutive turns held by one voice."""

    __slots__ = ("speaker", "turns")

    def __init__(self, speaker: str, turns: list[int]) -> None:
        self.speaker = speaker
        self.turns = turns


def _runs(turns) -> list[_Run]:
    out: list[_Run] = []
    for index, segment in enumerate(turns):
        speaker = (segment.speaker or "").strip()
        if out and out[-1].speaker == speaker:
            out[-1].turns.append(index)
        else:
            out.append(_Run(speaker, [index]))
    return out


def _speaking(segments) -> list:
    """Turns with words in them, which is what a turn number counts."""
    return [s for s in segments if getattr(s, "text", "") and s.text.strip()]


def display_name(current: str | None, status: str, inferred: str | None) -> str | None:
    """The precedence, stated once, in the order it is meant to be read.

    ::

        display =  a name a person gave this speaker      (manual, or a rematch)
                ?? a name the conversation gave them      (this module)
                ?? the label diarization produced         ("Speaker 2")

    Inference occupies the **middle** tier and can only ever fill an empty one.
    A name somebody typed, and a name an acoustic rematch resolved, are both
    "not a placeholder" — so both fall through the first branch and nothing
    below them is consulted. That is what makes "manual beats inferred" true by
    construction rather than by ordering the callers correctly.

    <h2>Why it is a function rather than a guard</h2>

    It was a negated condition inside ``apply`` — *don't write unless the label
    is unresolved* — which is the same rule read backwards, and a rule that can
    only be read backwards is one the next caller re-implements slightly
    differently. Stated forwards it can be called, tested and quoted.

    <h2>Unattributed turns</h2>

    ``status == "unknown"`` returns the label untouched and never consults
    ``inferred``. The provider declined to say whose the turn was, so the audio
    under it may be anybody's; naming it would be inventing the one fact the
    provider refused to supply. It is checked before the placeholder test on
    purpose — "Unknown speaker" *looks* like a placeholder and is not one.
    """
    if status == "unknown":
        return current
    if not current:
        # No label at all. `is_unresolved` deliberately calls this *not*
        # unresolved for the same reason: a turn with no speaker is an
        # unattributed one wearing a different spelling, and the audio under it
        # may be anybody's. Filling it in would be the guess, not the fix.
        return current
    if not is_unresolved(current):
        return current
    return inferred if inferred else current


def _nameable(segment) -> bool:
    """Whether inference is allowed to fill this turn's display name.

    The middle tier of :func:`display_name`, as a predicate: true exactly when
    the first branch would not have won and the third is all that is left.
    """
    return display_name(
        getattr(segment, "speaker", None),
        getattr(segment, "speaker_status", "attributed"),
        _PROBE,
    ) is _PROBE


#: A sentinel that cannot collide with a real name, so `_nameable` asks
#: `display_name` the question rather than restating its rules.
_PROBE = "\x00inferred\x00"
