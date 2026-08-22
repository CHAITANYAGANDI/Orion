"""Telling a lookup apart from an inventory.

"What did we decide about pricing?" wants a sentence. "What hasn't been
completed?" wants every row, and a sentence is the wrong answer even when every
word of it is true.

The model is given the whole action-item ledger either way — retrieval is not
the constraint here — so the difference is entirely in how it is asked to write.
Told to be concise, it does what a person would: it merges near-identical items
into one line and stops when the answer reads complete. Fifteen tracked items
come back as thirteen bullets, nothing is wrong, and nothing is countable.

So an inventory-shaped question swaps the instruction. That is the whole
mechanism: same context, different brief.

**Composition wins over enumeration.** "Draft an agenda from what was left open"
contains a list word and is not a list request — the reader wants an agenda, not
an agenda with "5 items." stapled to the end. Any question that asks for
something to be *written* is treated as prose regardless of what else it
contains, because getting that backwards produces a visibly broken artefact
while the reverse merely produces a shorter answer.
"""

from __future__ import annotations

import re
from enum import Enum

# Asking for something to be composed. Checked first and wins outright.
_COMPOSE = re.compile(
    r"\b(draft|write|compose|rewrite|reword|email|agenda|summari[sz]e|summary)\b",
    re.IGNORECASE,
)

_INVENTORY = [
    # Explicit requests for a list.
    r"\blist\b",
    r"\b(full|complete|exhaustive|entire) list\b",
    r"\bhow many\b",
    r"\ball (of )?(the|my|our)\b",
    r"\bwhat are all\b",
    r"\bevery\b",
    r"\beach\b",
    # Outstanding-work questions, which are inventories by nature.
    r"\boutstanding\b",
    r"\bstill (open|outstanding|pending|owed)\b",
    r"\b(unfinished|incomplete|uncompleted)\b",
    r"\bnothing\b.{0,20}\bdone\b",
    # "has not been completed", "does not appear to have been completed",
    # "hasn't been finished" — the phrasing varies more than the meaning.
    r"\b(not|never)\b.{0,30}\b(complete|completed|done|finished|delivered|resolved|answered)\b",
    r"\bhasn'?t\b.{0,30}\b(complete|completed|done|finished|delivered)\b",
    r"\bwho owes\b",
]

_INVENTORY_RE = re.compile("|".join(_INVENTORY), re.IGNORECASE)


def wants_full_list(question: str) -> bool:
    """True when the answer should enumerate rather than summarise.

    Deliberately conservative in one direction only. A missed inventory gives
    the answer we already had; a false positive puts a bullet list and a count
    where someone asked for a paragraph.
    """
    if not question:
        return False
    if _COMPOSE.search(question):
        return False
    return bool(_INVENTORY_RE.search(question))


# --- what kind of question is this ------------------------------------------ #
#
# `wants_full_list` above answers one bit: enumerate, or write prose. That bit
# is real and stays, but it is not enough to shape an answer. "How did the
# AssemblyAI decision change?" and "What did Sarah say about pricing?" are both
# prose and want completely different things — one is a sequence with dates,
# the other is one attributed statement, and answering either in the other's
# shape is how a correct answer still reads as a wrong one.
#
# This is a router, not a judge. It picks how to retrieve and how to write. It
# never decides what is true, never filters evidence on its own, and a
# misclassification costs a differently-shaped answer rather than a wrong one —
# which is why it is regex over the question rather than a model call: it runs
# on every question, and a classifier that costs a round trip would be paid for
# on every question too.

INTENTS = (
    "compose", "inventory", "timeline", "how_to", "comparison", "summary",
    "synthesis", "explain", "fact",
)

# `when did` used to be here and is deliberately gone. A timeline is an account
# of how something developed — ordered, dated, several steps. "When did they say
# the conference starts?" is one date the meeting stated, which is a lookup, and
# answering it in a timeline's shape is a correct answer wearing the wrong one.
# Real chronologies route on their own words, which are the ones left below.
_TIMELINE = re.compile(
    r"\b(timeline|chronolog\w*|history of|over time|evolve[ds]?|evolution|"
    r"how did .{0,40}\b(change|develop|progress|shift)|"
    r"in what order|sequence of)\b",
    re.IGNORECASE,
)

_COMPARISON = re.compile(
    r"\b(compare|comparison|versus|vs\.?|difference between|differ|"
    r"changed since|changed from|what changed|contradict\w*|conflict\w*|"
    r"disagree\w*|inconsisten\w*)\b",
    re.IGNORECASE,
)

_SUMMARY = re.compile(
    r"\b(summar\w+|overview|recap|brief me|catch me up|what happened|"
    r"what was discussed|what did we (talk|discuss))\b",
    re.IGNORECASE,
)

_SYNTHESIS = re.compile(
    r"\b(themes?|patterns?|recurr\w+|repeatedly|across (the |my |our )?"
    r"(meetings|calls|conversations)|common\w*|trends?|overall)\b",
    re.IGNORECASE,
)

# Asking how to *do* something, rather than what was said about it.
#
# This is the one intent whose answer may reach past the transcript, so its
# boundary is drawn tightly: a first person actor ("how can I", "what should we
# do") or an explicit request for steps. "How does the billing flow work?" is
# not here, and should not be — that is a question about what the meeting
# explained, and answering it from general knowledge would be inventing the
# user's own system.
_HOW_TO = re.compile(
    r"\b(?:"
    r"how (?:can|do|should|would|could|might|will) (?:i|we|you|one|someone)\b"
    r"|how to\b"
    r"|what should (?:i|we|you)\b"
    r"|what (?:do|does|did) (?:i|we|you) need to\b"
    r"|next steps?\b"
    r"|steps? (?:to|for)\b"
    # "What steps should I take?" — the actor is there but the word order puts
    # it past "what should I". Anchored on the pronoun rather than on "steps"
    # alone, because "what steps were agreed?" is a question about the meeting.
    r"|steps? (?:should|do|can|would|could) (?:i|we|you)\b"
    r"|walk me through\b"
    r"|(?:go about|get started)\b"
    r"|advice on\b"
    r"|recommend(?:ation)?s? (?:for|on)\b"
    r")",
    re.IGNORECASE,
)


# --- explaining a thing, versus reporting what was said about it ------------- #
#
# "What is Tech in Asia Conference 2025?" and "What did they say about the
# conference?" are both `what` questions about the same entity, and they want
# opposite answers. The second is a request to search a recording. The first is
# the reader's actual question, and answering it with a paraphrase of the
# recording is a search engine's answer:
#
#     "Tech in Asia Conference 2025 is an event that brings together founders,
#     product professionals, corporate leaders, and investors…"
#
# — accurate, grounded, and not what was asked.
#
# The boundary is drawn on two lexical signals, because the alternative is a
# model call on every question to decide the shape of every question.

# Anything pointing at the recording rather than at the thing. Checked first and
# refuses `explain` outright: "Explain what Sarah decided" wears an explanatory
# frame and is a question about a meeting.
_ABOUT_THE_RECORDING = re.compile(
    r"\b(?:"
    r"mention(?:s|ed|ing)?\b"
    r"|did (?:they|we|you|he|she|[A-Z][a-z]+) (?:say|list|agree|decide|state|quote|discuss)"
    r"|(?:they|we|you|he|she|[A-Z][a-z]+) (?:said|listed|agreed|decided|discussed|quoted)"
    r"|(?:was|were) (?:decided|agreed|discussed|said|quoted|raised)"
    r"|in (?:the|this|that) (?:meeting|call|transcript|speech|recording|conversation)"
    r"|according to the (?:meeting|call|transcript|speech|recording)"
    r")",
    re.IGNORECASE,
)

# A named thing, as opposed to an ordinary noun. This is what separates "what is
# Kubernetes" from "what is the deadline" — the second names a fact the meeting
# either records or does not, and no amount of general knowledge can supply this
# user's deadline.
#
# The capital is the signal, so it is tested case-sensitively with `(?-i:...)`
# inside an otherwise case-insensitive pattern: people do not reliably capitalise
# "what", and the whole rule collapses if they have to.
_NAME = r"(?-i:[A-Z])[\w.-]*"

# An article is allowed, because the regression question has one — "What is
# **the** Tech in Asia Conference 2025?" — but it raises the bar to two
# capitalised words. "The URL", "the API", "the CEO", "the PR" are common nouns
# in capitals far more often than they are names of things to explain, whereas a
# real proper name after an article almost always runs on: "the Tech in Asia
# Conference", "the Product Marketing Weekly". Without an article, one
# capitalised word is plenty: "Kubernetes", "Stripe", "RAG".
_NAMED = (
    "(?:"
    rf"(?:the|a|an|our|their|this|that)\s+{_NAME}(?:\s+[\w.-]+){{0,2}}\s+{_NAME}"
    rf"|{_NAME}"
    ")"
)

_EXPLAIN = re.compile(
    "(?:"
    r"\bexplain\b"
    r"|\btell me (?:about|more about)\b"
    rf"|\bwhat(?:'s| is| are)\s+(?:exactly\s+)?{_NAMED}"
    rf"|\bwhat\s+exactly\s+(?:is|are)\s+{_NAMED}"
    # "What does Kafka do?", "What does pgvector do?" — the frame is itself
    # explanatory whatever the casing, and nothing factual wears it. Note that
    # "what does registration cost?" does not match: `cost` is not in the list.
    r"|\bwhat do(?:es)?\s+[\w.-]+\s+(?:do|mean|stand for)\b"
    r"|\bwhat kind of (?:thing|company|product|service|event|tool)\b"
    ")",
    re.IGNORECASE,
)


def classify(question: str) -> str:
    """Which of {INTENTS} this question is, by the first rule that matches.

    Order is the design. Composition wins outright for the reason
    `wants_full_list` already gives — an agenda with "Total: 5." stapled to it
    is visibly broken. Inventory is second because "list every decision that
    changed" is a list first and a comparison second: the reader is counting.
    Timeline precedes comparison because "how did X change over time" contains
    the word change and wants an ordered account, not a two-column diff. Fact is
    the fallback, and is by far the commonest.

    How-to sits *after* inventory and timeline and before everything else, and
    both halves of that matter. "How many attendees were mentioned?" is a count
    and "how did the decision change?" is a sequence — each begins with the word
    how and neither is asking to be told how to do anything. What is left after
    those two is a genuine request for a procedure, which is the only intent
    allowed to reach past the transcript with a procedure. See
    `knowledge_policy`.
    """
    if not question or not question.strip():
        return "fact"
    if _COMPOSE.search(question):
        return "compose"
    if wants_full_list(question):
        return "inventory"
    if _TIMELINE.search(question):
        return "timeline"
    if _HOW_TO.search(question):
        return "how_to"
    if _COMPARISON.search(question):
        return "comparison"
    if _SUMMARY.search(question):
        return "summary"
    if _SYNTHESIS.search(question):
        return "synthesis"
    # Last before the fallback, on purpose. `explain` is the only intent that
    # takes questions away from another one, so putting it here means it can
    # only ever claim what would otherwise have been `fact` — every established
    # route keeps its priority and nothing else moves.
    if not _ABOUT_THE_RECORDING.search(question) and _EXPLAIN.search(question):
        return "explain"
    return "fact"


# Intents whose answers are lists of items the reader counts. The only ones that
# should ever produce an enumeration — which is the correction to Advanced mode
# having previously enumerated everything, so that "what does JWT mean here?"
# came back as one bullet and the line "Total: 1."
_ENUMERATING = frozenset({"inventory"})


def wants_enumeration(intent: str) -> bool:
    """Whether the answer should be a counted list rather than prose."""
    return intent in _ENUMERATING


# Intents that benefit from reading more of the archive rather than more of one
# passage. Advanced widens retrieval for every question; these are the ones
# where it also widens how many *meetings* may contribute, because the answer is
# a claim about several of them.
_CROSS_MEETING = frozenset({"comparison", "timeline", "synthesis", "inventory"})


def spans_meetings(intent: str) -> bool:
    """Whether this question is about the archive rather than about a passage."""
    return intent in _CROSS_MEETING


# Intents the tracked records can answer on their own, with no transcript
# passage at all. The action-item ledger and the decision record are *complete*
# rather than retrieved samples, so "what is still outstanding?" needs nothing
# from the transcripts — and neither does "what should I do after this
# meeting?", whose honest answer is the four things somebody was left holding.
#
# Everything else ends when the evidence does. A lookup with nothing behind it,
# handed only the ledger, produces a model describing the ledger back — which is
# the shape of answer this whole change exists to stop.
_FROM_RECORDS = _CROSS_MEETING | {"how_to"}


def answerable_from_records(intent: str) -> bool:
    """Whether the ledgers alone are a reasonable answer to this."""
    return intent in _FROM_RECORDS


# --- what the answer is allowed to draw on ----------------------------------- #
#
# The two knowledge classes, decided here and enforced in the prompt.
#
# **Meeting-sourced.** What somebody said, what was decided, who owns what, when
# it is due, the numbers and the names. These have exactly one source and it is
# the user's own evidence. Nothing else may supply them, supplement them or
# round them off.
#
# **General guidance.** How registering for a conference usually works, what a
# follow-up email conventionally contains, what a form will typically ask for.
# Stable, procedural, and not a claim about this user's meetings at all.
#
# Confusing them is the failure this distinction exists to prevent, and it is
# asymmetric. A meeting question answered from general knowledge produces a
# confident invented fact — a price nobody quoted, a date nobody set — which is
# indistinguishable from a real one to the person reading it. A question that
# reaches past the meeting, answered from the meeting alone, produces a reply
# that is merely unhelpful.
#
# There are two ways of reaching past it and they are **not the same
# permission**, which is why this is an enum and not a boolean. Modelling it as
# `guidance: bool` was fine while there was one exception; a second one would
# have made `True` mean "may add steps, or may add background, we no longer
# say" — and a policy nobody can name is a policy nobody can check.


class Knowledge(str, Enum):
    """Where an answer is allowed to get its material.

    Exactly one of these applies to any answer. Subclasses `str` so it can be
    logged, compared and put in a report without unwrapping, while still being
    a closed set that a typo cannot join.
    """

    #: The passages and nothing else. Every fact-shaped intent, and the default
    #: for anything unrecognised — "what price did they quote?" over a
    #: transcript with no price stays "the meeting doesn't state a price".
    MEETING_ONLY = "meeting_only"

    #: Plus the ordinary steps of a process. "How can I register?" cannot be
    #: answered from a recording of somebody saying "register now".
    PROCEDURAL_GUIDANCE = "procedural_guidance"

    #: Plus what a thing of this kind generally is and is for. "What is Tech in
    #: Asia Conference 2025?" is a question about the world that the meeting
    #: happens to touch, and a paraphrase of the meeting is not an answer to it.
    EXPLANATORY_BACKGROUND = "explanatory_background"


# Both exceptions are narrow and neither is a superset of the other: a
# procedural answer may lay out the usual steps of a process and may not
# describe what a conference is for; an explanatory one may do the reverse.
_POLICY: dict[str, Knowledge] = {
    "how_to": Knowledge.PROCEDURAL_GUIDANCE,
    "compose": Knowledge.PROCEDURAL_GUIDANCE,
    "explain": Knowledge.EXPLANATORY_BACKGROUND,
}


def knowledge_policy(intent: str) -> Knowledge:
    """What this intent's answer may draw on.

    Strict by default, so an intent added later and not listed here gains no
    permission by being forgotten. A misclassification is recoverable in both
    directions: neither exception relaxes grounding, so the cost is a paragraph
    of background or steps somebody did not need — never an invented fact.
    """
    return _POLICY.get(intent, Knowledge.MEETING_ONLY)


# --- who and what the question names ---------------------------------------- #

_SPEAKER = re.compile(
    r"\b(?:what|when|why|how|which)?\s*(?:did|does|do)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+"
    r"(?:say|said|mention|ask|promise|commit|decide|think|want|propose|suggest|raise)",
    re.IGNORECASE if False else 0,
)

_SPEAKER_POSSESSIVE = re.compile(r"\b([A-Z][a-z]+)'s\b")


def named_person(question: str) -> str | None:
    """The person a question is about, or None.

    Capitalisation is the signal, which is why this is case-sensitive: lowering
    the case first makes "did we say" match as enthusiastically as "did Sarah
    say", and the boost then applies to every question containing a verb.

    Used only to raise the score of passages that mention that name — never to
    filter. A meeting where the transcript spells a name differently, or where
    diarization never resolved it, must still be able to answer.
    """
    if not question:
        return None
    m = _SPEAKER.search(question)
    if m:
        return m.group(1).strip()
    m = _SPEAKER_POSSESSIVE.search(question)
    if m:
        return m.group(1).strip()
    return None


def names_meeting(question: str, titles: list[str]) -> list[str]:
    """Meeting titles the question appears to name, longest first.

    Substring rather than fuzzy matching, on normalised text. A user who writes
    "in the Product Marketing Weekly meeting" has named a meeting and expects
    that meeting; a user who happens to use three words that also appear in a
    title has not, which is why the match must be contiguous and why one-word
    titles are ignored — "Recording" would otherwise capture every question
    asked of an archive full of them.
    """
    if not question:
        return []
    haystack = " ".join(question.lower().split())
    hits: list[str] = []
    for title in titles:
        clean = " ".join((title or "").lower().split())
        if len(clean.split()) < 2 or len(clean) < 8:
            continue
        if clean in haystack:
            hits.append(title)
    hits.sort(key=len, reverse=True)
    return hits


_LOOKS_NAMED = re.compile(
    r"(?<!^)\b[A-Z][a-zA-Z0-9]+\b|\b(meeting|call|sync|standup|stand-up|review|"
    r"session|kickoff|retro|1:1|one-on-one)\b",
    re.IGNORECASE if False else 0,
)


def could_name_a_meeting(question: str) -> bool:
    """Whether it is worth reading the archive's titles to find out.

    `names_meeting` needs the titles, and reading them is a query. Most
    questions — "what changed since last week?", "what is still open?" — cannot
    possibly name a meeting, and running that query on every one of them buys
    nothing. A capitalised word that is not the first, or one of the words
    people use for a meeting, is the cheapest signal that it might.

    Wrong in the safe direction: a false positive costs one indexed lookup, a
    false negative costs a wider search, which is where this started.
    """
    if not question:
        return False
    return bool(_LOOKS_NAMED.search(question))
