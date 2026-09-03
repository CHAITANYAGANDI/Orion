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

<h2>The model proposes candidates; the meeting decides between them</h2>

A claim is evidence that a name is *worth considering* for somebody. It is not a
vote, and it used to be counted as one — the tally was over claims, so whichever
name the model happened to write down won, however many times the transcript
said something else. That is the whole of the near-homophone failure: ASR hears
one participant as **Cindy** three times and **Sydney** once, the model quotes
the Sydney turn, and one transcription error outranks three independent
mentions that were never counted because nothing looked for them.

So the two jobs are separated. Verified claims contribute a **pool of candidate
names**; the weight behind each candidate is then counted **over the whole
meeting** by re-running the same structural checks against every turn. A name is
supported by the turns that address the speaker by it, not by the number of
times a model mentioned it.

<h2>Independent evidence, weighted by whether it could be checked</h2>

Each *distinct turn* contributes once, so a model repeating itself about one
sentence cannot manufacture support. What a turn is worth depends on whether
anything could confirm who spoke it — the same ``_ownership_is_sound`` question
asked elsewhere in this file. A vocative sitting in a half-second fragment that
diarization never verified is real evidence and weak evidence, and weighting it
below a sound turn is what stops one poor ASR moment from outranking several
good ones.

A self-introduction outweighs being addressed, because *"Hi, I'm Sarah"* is a
person stating their own name and needs no corroboration to be worth more than
somebody else's pronunciation of it.

<h2>Ties refuse, and so do narrow wins</h2>

The winner must be **at least twice as well supported** as the runner-up. Five
turns calling somebody Michael and one calling them Mike is a nickname and
resolves; three against two is a transcript that genuinely disagrees with
itself, and the honest answer there is none. This mirrors the *margin* rule in
``app.voiceprints``: when the best answer is not distinctly the best, refuse.

One name claimed for **two** speakers refuses both, with no margin. That
collision is the signature of a third-person mention leaking in ("Michael said
he'd handle it"), and unlike the nickname case the two candidates are not two
descriptions of one person — they are two people, one of whom is about to be
given the other's name.

<h2>What it will not touch</h2>

Anything that already has a name — typed by the user, resolved by an earlier
rematch, or returned by the provider's own speaker identification — and any turn
the provider declined to attribute at all. Both guards are
``app.diarization.is_unresolved`` and the ``unknown`` status, so there is one
definition of "still a placeholder" in the service rather than two that can
drift. It lives beside the numbering that produces those labels.

Nothing here is fatal. A meeting whose speakers cannot be named is a meeting
with Speaker 1 and Speaker 2 in it, which is exactly where it started.
"""

from __future__ import annotations

import logging
import re

from app.diarization import is_unresolved
from app.quotes import normalise

logger = logging.getLogger("ai-service.naming")

#: Below this, a turn is too short for anything to have confirmed who owns it.
#:
#: Owned here, as a plain number. It was previously imported from the speaker
#: embedder — that model refused to answer for a shorter stretch, so the floor
#: was genuinely the model's — and naming is no longer downstream of any
#: acoustic component. Carrying the import forward would have made this module
#: depend on a package it never calls, for a float.
#:
#: The value and its meaning are unchanged. Eight tenths of a second is about
#: the shortest stretch of speech anything can attribute with confidence, and
#: the rule is the same either way: a turn under it has an owner nothing has
#: verified.
#:
#: The distinction matters and was got wrong once. A blanket "a speaker must
#: have spoken for N seconds in total" rule suppresses *"Hi, I'm Sarah"*, which
#: takes about a second and a quarter and is the best identity evidence a
#: meeting can hold. This asks a different question about each turn: could
#: anybody have checked who said it?
MIN_VERIFIABLE_SECONDS = 0.8

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

#: What one turn of evidence is worth.
#:
#: Weights rather than counts, because the kinds of evidence are not
#: interchangeable. A person saying their own name is not the same claim as
#: somebody else pronouncing it, and a vocative in a turn whose owner nothing
#: could verify is not the same claim as one in a turn that was checked.
#:
#: The ratios are what matter, not the numbers: an introduction outweighs three
#: separate people addressing you, and an unverifiable turn can corroborate a
#: name but never carry one on its own against sound evidence.
INTRODUCTION_WEIGHT = 6
ADDRESS_WEIGHT = 2

#: A vocative in a turn `_ownership_is_sound` rejects. Deliberately non-zero:
#: the words were still said, and discarding them entirely would throw away the
#: corroboration that makes a majority a majority. Deliberately below
#: `ADDRESS_WEIGHT`: on its own it cannot outrank a turn somebody could check.
UNVERIFIED_WEIGHT = 1

#: How much better supported the winner has to be. Two contradictory names for
#: one speaker are a transcript disagreeing with itself, and the cost of picking
#: the wrong one is a real person's name on the wrong voice for the length of a
#: meeting. Twice the evidence, or leave the number alone.
WINNING_MULTIPLE = 2

#: Longest a name may be, in words. Enough for "Mary Jane" or "Van Der Berg",
#: short enough that a clause the model mistook for a name cannot get through.
MAX_NAME_WORDS = 3

#: And in characters, against a single very long token.
MAX_NAME_CHARS = 40

#: A word as it appears in the raw text, before `app.quotes.normalise` strips
#: the punctuation that spelling arbitration reads.
_WORD = re.compile(r"[^\W\d_][\w'’\-]*", re.UNICODE)

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
        # Pronouns. "I" is capitalised in every sentence of English and lands
        # between commas constantly -- "it may end up, Cindy, being you and I,
        # just picking one" -- so without this it is the best-corroborated
        # "name" in most meetings by an order of magnitude. Nobody is called
        # any of these, and a model claiming one was not reading.
        "i", "me", "my", "mine", "myself", "you", "your", "yours", "we", "us",
        "our", "ours", "he", "him", "his", "she", "hers", "they", "them",
        "their", "theirs", "it", "its", "this", "that", "these", "those",
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


def _ownership_is_sound(segment) -> bool:
    """Whether who owns this turn is known well enough to name them from it.

    Two ways it is not, and neither of them is "this person did not say much".

    **The acoustic layer tried and failed.** ``speaker_provisional`` marks a
    turn some acoustic pass examined and could not resolve. The provider's
    answer stands because it is the best one available, but it is known to be
    unconfirmed, and an unconfirmed owner is not somebody to attach a real
    person's name to.

    Nothing sets it today — its only writer was the meeting-local refinement
    removed in stage two — so this branch is dormant rather than dead. The
    rule is kept because it is the correct rule, and re-deriving it later
    would be re-deciding a question already settled here.

    **The acoustic layer could not have checked.** Below the embedder's own
    ``MIN_SPAN_SECONDS`` there is no vector to compare — `embed` refuses rather
    than returning one it does not believe — so ownership of such a turn has
    never been verifiable by anything. Half a second of audio reading "I." is
    exactly this: whoever the provider filed it under, nothing has confirmed it
    and nothing can.

    Note what this is *not*. It is a per-turn question about ownership, not a
    budget a participant has to spend to deserve a name. Somebody whose whole
    contribution is *"Hi, I'm Sarah"* has said one thing, it lasts well over the
    floor, and it is the strongest identity evidence a meeting can contain.
    """
    if getattr(segment, "speaker_provisional", False):
        return False
    start, end = getattr(segment, "start", None), getattr(segment, "end", None)
    if start is None or end is None:
        return True                       # no timings at all: not evidence of a fault
    # The tolerance is for the arithmetic, not the rule: a duration is a
    # subtraction of two floats, and a turn the provider timed at exactly the
    # floor can land a fraction under it. Without this the boundary behaves
    # differently depending on where in the recording the turn happens to sit.
    return float(end) - float(start) >= MIN_VERIFIABLE_SECONDS - 1e-6


def open_labels(segments) -> list[str]:
    """The speaker labels a name is allowed to be attached to.

    Placeholders only, attributed only, and **holding at least one turn whose
    ownership is sound** — in the order they first speak. Handed to the model so
    it is asked about the right people, and enforced again on the way back: the
    wire is not a place to keep a rule.

    One sound turn is the whole requirement. A speaker who has one and a dozen
    unverifiable fragments is a person who was diarized imperfectly; a speaker
    who has *only* fragments is far more likely to be an artefact of a boundary,
    and naming one puts a real person's name somewhere nothing has confirmed.
    """
    sound: set[str] = {
        segment.speaker for segment in _speaking(segments)
        if _nameable(segment) and _ownership_is_sound(segment)
    }
    seen: list[str] = []
    for segment in _speaking(segments):
        label = segment.speaker
        if not _nameable(segment) or label in seen or label not in sound:
            continue
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

    # Step one: which names are worth considering for whom. A claim earns a
    # name a place on the ballot; it does not cast a vote.
    #
    # Candidates stay bound to the speaker the claim named. Letting a name
    # claimed for one speaker be weighed against every other would have this
    # function reading names out of the transcript on its own, which is the
    # "decide whether Faith is a person" problem the whole module avoids.
    #
    # Keyed by casefold, so "Cindy" and "cindy" are one candidate rather than
    # two splitting the same evidence between them -- which on its own could
    # hand the meeting to a third spelling that never split.
    candidates: dict[str, dict[str, str]] = {}
    introduced: dict[str, dict[str, set[int]]] = {}
    for claim in claims:
        verified = _verified(claim, turns, runs, open_now)
        if verified is None:
            continue
        label, name, index, basis = verified
        key = name.casefold()
        spellings = candidates.setdefault(label, {})
        spellings[key] = _better_spelling(spellings.get(key), name)
        if basis == "introduced":
            introduced.setdefault(label, {}).setdefault(key, set()).add(index)

    # Step two: weigh each candidate over the whole meeting. This is the step
    # the old tally skipped -- it counted the claims it was handed and never
    # went looking for the turns.
    support: dict[str, dict[str, int]] = {}
    for label, spellings in candidates.items():
        for key, name in spellings.items():
            weight = _weigh(label, key, name, turns, runs, introduced)
            if weight:
                support.setdefault(label, {})[name] = weight

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

    # Phase one is over: who can be named, and who the name refers to, is now
    # settled and is not revisited. Phase two only ever rewrites the *spelling*
    # of what phase one decided.
    attributed = _drop_collisions(resolved)
    spoken_for = {
        label for label, name in attributed.items()
        if name.casefold() in introduced.get(label, {})
    }
    return _drop_collisions(_arbitrate(attributed, turns, taken, spoken_for))


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


def _arbitrate(attributed, turns, taken, spoken_for) -> dict[str, str]:
    """Phase two. The spelling of an attributed name, and nothing else.

    <h2>What this is allowed to change</h2>

    One thing: the string shown for a speaker **phase one already named**. It
    iterates over the result of attribution, so it cannot name a speaker who
    was not named, cannot un-name one who was, and cannot move a name from one
    canonical speaker to another — every key in the mapping it returns was
    already a key in the mapping it received.

    <h2>Why it is needed at all</h2>

    Attribution asks *who is being addressed*, and answers it with adjacency:
    you are addressed by somebody you are in the conversation with. That is
    right for attribution and wrong for spelling. Somebody addressed at one
    point who does not speak again for two minutes fails the adjacency test, so
    a correctly transcribed vocative can contribute nothing, while a single
    mistranscription of the same person's name that happens to land beside them
    contributes everything.

    Spelling does not need adjacency, direction, or reach. *"Cindy's comment"*
    is useless for deciding whose turn it is — it is somebody being talked
    about — and it is excellent for deciding how that person's name is spelled.
    Phase two is where that evidence is allowed to count, and it is kept out of
    phase one so it can never decide who anybody is.

    <h2>Self-introduction is final</h2>

    A speaker named because they said their own name is not arbitrated. Nobody
    else's pronunciation of a name outranks the person whose name it is.
    """
    out = dict(attributed)
    for label, incumbent in attributed.items():
        if label in spoken_for:
            continue

        # Nobody else's name, and nothing a person typed. Guard against the
        # case the whole exercise is shaped around in reverse: two real
        # participants called Michael and Michelle must not collapse into one.
        barred = {name.casefold() for other, name in attributed.items() if other != label}
        barred |= set(taken)
        barred.add(incumbent.casefold())

        standing = _occurrence_turns(incumbent, turns)
        rivals: dict[str, int] = {}
        for key, name in _nominated_spellings(label, turns).items():
            if key in barred or not _one_name_two_spellings(incumbent, name):
                continue
            rivals[name] = len(_occurrence_turns(name, turns))

        if not rivals:
            continue
        best = _clear_winner(rivals)
        if best is None:
            continue                      # two rivals, no clear answer: leave it
        if rivals[best] < max(1, len(standing)) * WINNING_MULTIPLE:
            continue                      # ahead, but not clearly enough
        logger.info(
            "Speaker naming: a spelling was replaced on meeting-wide evidence "
            "(%d turns against %d).", rivals[best], len(standing))
        out[label] = best
    return out


def _one_name_two_spellings(incumbent: str, candidate: str) -> bool:
    """Whether these could be one name written two ways.

    <h2>Why this exists, and what it is not for</h2>

    Phase two arbitrates **spellings**. Without a test of what counts as a
    respelling it is not arbitration at all — it is "replace this speaker's
    name with whatever capitalised word the meeting says most", and on real
    transcripts that is a product name. Measured, not supposed: on the meeting
    this was built against, the strongest rival to the attributed name was a
    chat tool mentioned throughout, and it won until this test was added.

    **This is not what keeps two real people apart.** Michael and Michelle,
    Brian and Bryan, Cindy and Sandy all pass it — they are near-identical
    strings — and every one of them is kept separate by the attributed-elsewhere
    guard instead. Do not read a similarity score here as a judgement that two
    participants are the same person; it is only a filter that keeps phase two
    inside its own job.

    <h2>The measure</h2>

    Consonants, as a set, sharing at least half of the larger name. Consonants
    because vowels are what transcription mangles, as a set because the failure
    is transposition — *Cindy* and *Sydney* are the same consonants in a
    different order — and half because the alternative is a distance threshold
    tuned against one pair of names, which would be worth less than it looked.
    """
    here, there = _skeleton(incumbent), _skeleton(candidate)
    if not here or not there:
        return False
    return len(here & there) * 2 >= max(len(here), len(there))


def _skeleton(name: str) -> frozenset:
    """The consonants of a name. `y` counts as a vowel: it is a spelling of one."""
    return frozenset(letter for letter in name.casefold()
                     if letter.isalpha() and letter not in "aeiouy")


def _nominated_spellings(label, turns) -> dict[str, str]:
    """Alternative spellings entitled to compete for this speaker's name.

    A spelling earns a place only by appearing in a **name-like vocative
    position** somewhere in the meeting, in a turn this speaker does not hold.
    Corroboration alone never nominates: *"Cindy's comment"* can support a name
    that a vocative already put forward and can never introduce one, because a
    possessive is a reference to somebody and carries no claim that they are in
    the room.
    """
    found: dict[str, str] = {}
    for turn in turns:
        if (turn.speaker or "").strip() == label:
            continue
        for name in _vocatives_in(turn.text):
            found.setdefault(name.casefold(), name)
    return found


def _occurrence_turns(name, turns) -> list[int]:
    """Every turn using this name at all — addressed, mentioned or possessive.

    Counted per **turn**, so a speaker who says a name three times in one
    breath has said it once. This is the corroboration measure, and it is
    deliberately indifferent to grammar: what is being counted is how much of
    the meeting uses this spelling for somebody, not who they are.
    """
    return [index for index, turn in enumerate(turns)
            if _locate(name, turn.text) is not None]


def _vocatives_in(text: str) -> list[str]:
    """Name-shaped words standing where a person is spoken to.

    Read off the **raw** text, because the signal is punctuation and
    `app.quotes.normalise` removes it. A vocative is parenthetical — set off
    from the clause around it — which is what separates *"...end up, Cindy,
    being..."* from *"we use Salesforce, which is great"*: the second is not
    set off before, it is the object of a verb.

    Three requirements, all orthographic or grammatical, none of them an
    opinion about whether a word is a person:

    1. **Set off before** — the previous character is a comma or a colon, or
       the previous word is one of the discourse markers a vocative follows
       ("Hi Michael,", "Thanks Michael,"). A word at the *start* of a sentence
       does not qualify: capitalisation there is automatic and carries no
       information, and the slot is full of open-ended discourse markers
       ("Anyway, ...") that no closed list will ever finish covering. The cost
       is that *"Michael, can you take this?"* does not nominate; it is a cost
       worth paying, and such a meeting almost always says the name elsewhere.
    2. **Closed after** — a comma, or the end of the sentence.
    3. **Capitalised**, and passing the same `_clean_name` checks a claimed
       name passes.

    Together these are strict enough that a possessive, a reporting verb, a
    product name in object position and a lowercase discourse marker all fail,
    without this function ever deciding whether "Faith" is a person.
    """
    found: list[str] = []
    for match in _WORD.finditer(text):
        word = match.group(0)
        if not word[:1].isupper():
            continue
        name = _clean_name(word)
        if not name:
            continue
        if not _set_off_before(text[:match.start()]):
            continue
        if not _closed_after(text[match.end():]):
            continue
        found.append(name)
    return found


def _set_off_before(before: str) -> bool:
    trimmed = before.rstrip()
    if not trimmed:
        return False                      # start of the turn: no information
    if trimmed[-1] in ",;:":
        return True
    if trimmed[-1] in ".?!":
        return False                      # start of a sentence: no information
    words = _WORD.findall(trimmed)
    return bool(words) and words[-1].strip(".,'’").casefold() in _NOT_A_NAME


def _closed_after(after: str) -> bool:
    trimmed = after.lstrip()
    return not trimmed or trimmed[0] in ",.?!;:"


def _weigh(label, key, name, turns, runs, introduced) -> int:
    """How strongly the whole meeting supports calling ``label`` this name.

    Every turn is asked the same structural questions the claim checks ask, so
    a name is supported by the conversation rather than by how often a model
    chose to mention it. Each distinct turn counts once.
    """
    weight = 0
    for index in introduced.get(label, {}).get(key, ()):
        weight += INTRODUCTION_WEIGHT if _ownership_is_sound(turns[index]) \
            else UNVERIFIED_WEIGHT
    for index in _addressed_turns(name, label, turns, runs):
        weight += ADDRESS_WEIGHT if _ownership_is_sound(turns[index]) \
            else UNVERIFIED_WEIGHT
    return weight


def _addressed_turns(name, label, turns, runs) -> list[int]:
    """Every turn in the meeting that addresses ``label`` by ``name``.

    The same four rules `_verified` applies to a claim's own turn, applied to
    all of them: said by somebody else, containing the name as whole words,
    not talking *about* that person, and close enough that they are who was
    being spoken to.

    Scanning the meeting is what makes repeated evidence count. It cannot
    invent a name — the candidate had to be quoted by a verified claim naming
    *this* speaker before it gets here — so this widens the *support* for a
    name without widening the set of names anybody can be given.

    Turns the speaker holds themselves are skipped, which also keeps a
    self-introduction from being counted twice: *"Hi, I'm Sarah"* is already
    weighed as an introduction, and matching the bare name in it again would
    read it as somebody being called Sarah.
    """
    found: list[int] = []
    for index, turn in enumerate(turns):
        if (turn.speaker or "").strip() == label:
            continue                      # nobody is addressed by themselves
        at = _locate(name, turn.text)
        if at is None:
            continue
        if _is_mention(name, turn.text, at):
            continue
        if not _within_reach(label, index, runs):
            continue
        found.append(index)
    return found


def _better_spelling(current: str | None, candidate: str) -> str:
    """One spelling to show for a candidate whose case varies across claims.

    Only about presentation — the candidates were already merged by casefold
    before this is consulted. A capitalised spelling wins because it is the one
    a reader expects on a name; otherwise the first one seen stands, so the
    choice is stable rather than dependent on claim order.
    """
    if current is None:
        return candidate
    if not current[:1].isupper() and candidate[:1].isupper():
        return candidate
    return current


def _verified(claim, turns, runs, open_now) -> tuple[str, str, int, str] | None:
    """One claim, or None. Every rejection is a rule, never a judgement.

    Returns the turn index and basis as well as the name, because `resolve`
    counts *distinct turns* of evidence: without the index it cannot tell two
    claims about one sentence from two independent mentions.
    """
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
        return (label, name, index - 1, basis) if spoken_by == label else None

    # "How are you, Michael?" — said by somebody else, about somebody near.
    if spoken_by == label:
        return None
    if _is_mention(name, quote, at):
        return None
    if not _within_reach(label, index - 1, runs):
        return None
    return (label, name, index - 1, basis)


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

    "Michael" five times beside "Mike" once is a nickname and resolves. Three
    against two is a transcript contradicting itself and does not — the same
    refusal, and the same reasoning, as the margin check on voice matching.

    The bar is a *multiple* rather than a difference because the evidence is
    weighted: a fixed gap would mean something different for a meeting where
    somebody is named twice than for one where they are named twenty times.
    """
    if not names:
        return None
    # Name breaks the tie in the sort only to keep the ordering deterministic;
    # a genuine tie is refused two lines later regardless.
    ranked = sorted(names.items(), key=lambda kv: (-kv[1], kv[0]))
    if len(ranked) > 1 and ranked[0][1] < ranked[1][1] * WINNING_MULTIPLE:
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
