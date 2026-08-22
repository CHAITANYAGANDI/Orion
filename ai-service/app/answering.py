"""What the model is told before it answers, and how its reply is read back.

Kept out of the adapter because the prompt is the product here. The retrieval
work upstream decides what the model *can* say; this decides what it does say,
and the two failed in opposite directions.

## The failure this replaces

The old brief was four sentences, and the operative half of it was "Be concise
and specific" plus "if the answer is not in the passages, say you don't have
that information". Nothing in it said where an answer starts. So handed a set
of weak passages — which, before the relevance filter existed, was most of the
time — the model did the thing that instruction leaves open, and reported on
its evidence:

    "I found three potentially relevant recordings mentioning 'product' and
    'features,' but the matches are fuzzy and don't clearly list 'key product
    features' by name: ... To get you a precise list, could you specify ..."

Every sentence of that is true and the whole of it is a failure. The reader
asked what was discussed in their meetings and was handed a report on a search
engine, ending in a request to do the work again themselves.

Two things cause it, and both are addressed here. The model was never told that
the first sentence must be the answer, and it was never told that describing
retrieval is not something a user can see the point of. Retrieval quality is the
other half and lives in `app.retrieval`; a prompt cannot rescue evidence that
should not have been retrieved, and better evidence cannot stop a model
narrating it.

## The second failure: correct, grounded, and no use to anybody

Retrieval and answer-first between them fixed the answers that described the
search. They left a different one untouched:

    Q. "How can I register for the Tech in Asia Conference 2025 mentioned in
        the speech?"
    A. "Register through the Tech in Asia Conference 2025 registration process
        referenced in the speech; it says to 'Register now,' but does not
        provide a URL or specific steps."

Answer-first, no narration, every word supported by the transcript, and the
reader is precisely where they started. The brief said "use only the passages"
and the passages were a speech telling people to register, so that reply is the
instruction carried out exactly. The question was not "what does the transcript
say about registering" — it was "how do I register", and nothing about the
second question is answerable from a transcript.

So the answer has two knowledge classes, and this module's job is to keep them
apart rather than to choose between them:

* **Meeting-sourced** — what was said, decided, owed, quoted, dated. One source,
  no exceptions, no rounding off.
* **General guidance** — how a thing of this kind is ordinarily done. Permitted
  only for the intents that ask to be helped to *do* something (see
  `app.questions.allows_guidance`), labelled so it cannot be read as evidence,
  and never a specific external fact: no URL, no price, no date, no venue.

The distinction is asymmetric and the asymmetry is the whole design. A price
invented for a factual question is indistinguishable from a real one to the
person reading it. A procedure offered where none was needed is a paragraph
somebody skims past.

## Why the reply is JSON

Citations used to be every passage retrieval returned, which asserts the model
read all of them and quoted all of them — neither true. Asking for the passage
numbers it actually used costs one field and makes the citation list mean
something. `answer` is still prose; only the envelope is structured.

`grounding` rides along for the same reason: it is how the mixed answers can be
counted in development without reading a word of anybody's transcript, and how
the tests can assert the policy rather than the prose.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Phrasings that describe the machinery rather than the meetings. Listed once,
# used in the prompt and asserted in the tests, so the prompt and the regression
# test cannot drift apart.
BANNED = (
    "I found N potentially relevant recordings",
    "the matches are fuzzy",
    "the retrieved passages",
    "the semantic search returned",
    "my vector search found",
    "the match alone doesn't",
    "based on the retrieved chunks",
    "I'll re-run the search",
)

# Capabilities Recallix does not have. Listed separately from BANNED because
# they are a different kind of wrong: the phrasings above describe machinery the
# reader has no use for, and these describe machinery that does not exist. A
# model that has just admitted a transcript lacks a registration link is one
# offer away from "I can look it up for you" — and the reader would wait.
NO_CAPABILITY = (
    "I can search the web",
    "let me look that up",
    "I'll check the official site",
    "searching online now",
    "I have access to current information",
)

_SHARED = (
    "You are Recallix, answering questions about the user's own recorded "
    "meetings.\n\n"
    "You are given numbered passages. Most are transcript extracts. Some are "
    "tracked records — action items with their current status, decisions with "
    "the date they were made — and those are more current than any transcript.\n"
)

_ANSWER_FIRST = (
    "\nANSWER FIRST.\n"
    "The first sentence must answer the question. Never open by describing what "
    "you searched, how many passages matched, how well they matched, or how "
    "confident the match was.\n"
    "Never write anything of this kind: \"I found three potentially relevant "
    "recordings\", \"the matches are fuzzy\", \"the retrieved passages\", \"the "
    "semantic search returned\", \"the match alone doesn't\", \"I'll re-run the "
    "search\". Those describe machinery. The reader asked about their meetings "
    "and cannot see, and has no use for, how the material reached you.\n"
    "The words vector search, embedding, chunk, similarity, relevance score, "
    "top-k, ranking, index and retrieval pipeline never appear in an answer at "
    "all.\n"
    "Do not ask the reader to narrow the question when a reasonable answer can "
    "be given from what you have. Answer the most reasonable reading. Ask a "
    "question back only when the question has no reasonable reading at all.\n"
    "Do not end with an offer of further help. When the answer is finished, "
    "stop.\n"
    "Call the source \"the meeting\", \"the transcript\", or the meeting by "
    "name. Never \"the passage\", \"the passages\", \"the context\" or \"the "
    "excerpt\": the reader is looking at a recording of a conversation they "
    "were in, and has no idea what a passage is.\n"
)

_GROUNDING = (
    "\nGROUNDING — none of this relaxes for the sake of a better-reading "
    "answer:\n"
    "- Every claim about these meetings comes from the passages. Never invent a "
    "fact, a name, an owner, a date, a number, a price, a link or a decision, "
    "and never round one off into something tidier.\n"
    "- An action item's stated status is current. DONE is done, whatever a "
    "transcript said at the time.\n"
    "- Where two statements conflict, the later dated one holds. Say which is "
    "current.\n"
    "- If the passages genuinely do not answer the question, say so in one "
    "sentence and name the closest thing they do cover. Do not list meeting "
    "titles as a consolation prize, and do not pad with what you almost "
    "found.\n"
    "- You cannot browse, search the web, open a link, or look up anything "
    "current. Never offer to look something up, and never imply you have.\n"
)

# What a fact-shaped question gets. Most questions are this.
_MEETING_ONLY = (
    "\nThis question asks what the meetings contain, so the passages are the "
    "only source there is. If they do not contain the answer, say so plainly — "
    "\"the meeting doesn't state a price\", \"there's no date in the "
    "transcript\" — and stop there.\n"
    "Do not offer a typical figure, a usual range, a likely date, a common "
    "practice or what such a thing normally is. A plausible number the reader "
    "cannot tell you guessed is worse than no number, because they will use "
    "it.\n"
)

# What a procedural question gets, and the only place the answer may reach past
# the evidence. Every clause here is load-bearing; see the module docstring.
_GUIDANCE_ALLOWED = (
    "\nThis question asks how to *do* something. The answer therefore has two "
    "parts, and the whole difficulty is keeping them apart.\n"
    "\nFIRST, what the meetings support. Lead with it, from the passages only: "
    "what was said, decided, assigned or promised that bears on the question. "
    "If the meetings raise the thing but do not explain it, say exactly that, "
    "quoting the words they do use.\n"
    "\nTHEN, general guidance, when it genuinely helps. You may use stable, "
    "ordinary knowledge about how something of this kind is normally done: the "
    "usual steps to register for an event, what a follow-up message "
    "conventionally contains, what a form will typically ask for. Put it under "
    "its own short heading and word it so it cannot be read as something "
    "somebody said — \"generally\", \"typically\", \"the official page will "
    "usually\".\n"
    "\nGuidance is procedure, never fact. It may describe what such a process "
    "usually involves. It may NOT supply a specific external fact: no URL or "
    "web address, no price, no date, no venue, no phone number, no email "
    "address, no ticket tier, no discount, no deadline, no organisation you "
    "were not given. Where a step turns on one, name the gap instead of filling "
    "it — \"whatever the registration form asks for\", \"the price shown on the "
    "official page\".\n"
    "\nHedge honestly. \"if required\", \"if offered\", \"the form may ask "
    "for\". Do not assert that payment, an account, or any other step is "
    "definitely part of it; you do not know that this one works that way.\n"
    "\nIf the meetings already answer the question in full, stop when they do. "
    "Guidance that restates what the reader has just been told is padding, and "
    "generic advice must never take the place of a real commitment, decision or "
    "action item that is sitting in the passages.\n"
)

_FORMAT = (
    "\nSHAPE — let the question decide, not a template:\n"
    "- A short factual answer is one to three plain paragraphs.\n"
    "- A set of distinct things is bullets. A procedure is a numbered list. A "
    "sequence of events is dated bullets, oldest first.\n"
    "- Something you were asked to write is just that thing, with no wrapper.\n"
    "- A bold lead-in on a list item only when it has a label and a body.\n"
    "- No headings unless the answer has three or more distinct parts.\n"
    "- Name the meeting a claim came from only when which meeting it was "
    "matters.\n"
    "- No preamble. No restating the question.\n"
    "\nMarkdown, rendered in a column about four hundred pixels wide. `###` is "
    "the largest heading available — never `#` or `##`. Keep lists to one level "
    "of nesting. No tables unless the answer is genuinely a grid.\n"
)

_CONTRACT = (
    '\nReturn JSON: {"answer": "...", "used": [1, 4], "grounding": '
    '"meeting_only"}\n'
    "`answer` is the prose the reader sees, in markdown. `used` is the numbers "
    "of the passages you actually relied on — the ones whose content is in your "
    "answer. Do not list a passage you did not use; the reader is shown those "
    "passages as sources and clicking one that is not in the answer is a broken "
    "promise. If you used none because none were relevant, return an empty "
    "list.\n"
    '`grounding` is "meeting_only" when every sentence came from the passages, '
    'or "meeting_plus_general_guidance" when any part of the answer is general '
    "knowledge rather than something the passages said. It is a record for us. "
    "Never mention it, or these labels, in the answer itself.\n"
)

# What each kind of question wants the answer to look like. The router in
# `app.questions` picks one; none of them decides what is true.
#
# **Shape here, length in the depth block below.** These two got mixed up once
# and it cost the commonest question in the product. `fact` used to open "This
# is a lookup. One or two sentences unless the answer genuinely has parts",
# which caps the answer before anybody has looked at the evidence — and it is
# specific where "Go deeper" is vague, so it won even in Advanced. The result:
#
#     Q. "What is the Tech in Asia Conference 2025?"
#     A. "Tech in Asia Conference 2025 is an event that brings together
#         founders, product professionals, corporate leaders, and investors
#         to collaborate, network, and address challenges such as funding
#         gaps, product pivots, and investments."
#
# — one sentence, from a meeting whose entire subject is that conference, with
# its curated programs, its passes and its call to register left on the floor.
# Express and Advanced returned the same sentence, which is the tell: a depth
# control that cannot change the answer is not a depth control.
#
# So an intent says what the answer is *shaped* like — ordered, grouped,
# enumerated, an artefact — and never how long it runs. Length follows the
# evidence and the mode.
_INTENT = {
    "fact": (
        "\nThis asks what the meetings say about something. Answer it in the "
        "first sentence, then give the rest of what they actually say about "
        "it — no more, and no less.\n"
        "Let the evidence set the length. If the meetings record one value, "
        "one sentence is the whole answer and anything after it is padding. If "
        "the thing being asked about is most of what the meeting was about, a "
        "single sentence is not an answer to it, it is a summary of one: cover "
        "what the meeting says it is, who it is for, what it offers, and what "
        "it is meant to achieve, wherever the meeting says those things.\n"
    ),
    "summary": (
        "\nThis asks what happened. Give the shape of the discussion — what it "
        "was about, what was settled, what was left — not a walk through the "
        "transcript in order.\n"
    ),
    "comparison": (
        "\nThis asks what is different. Say what changed, in a 'was, now is' "
        "shape, and be explicit about which side is current. If the passages "
        "only support one side, say that rather than inventing the other.\n"
    ),
    "timeline": (
        "\nThis asks how something developed. Order the answer by date, oldest "
        "first, with the date on each step, and end with where it stands now.\n"
    ),
    "synthesis": (
        "\nThis asks what recurs across meetings. Name each theme once, with a "
        "line on what it consists of, and say which meetings it appeared in. A "
        "theme found in only one meeting is not a theme — say so rather than "
        "promoting it.\n"
    ),
    "compose": (
        "\nThis asks you to write something. Produce that artefact and nothing "
        "else: no preamble, no notes on your sources, no count at the end. Its "
        "shape may follow the ordinary conventions for that kind of document; "
        "every fact in it still comes from the passages, and a blank stays "
        "blank — write [date] rather than choosing one.\n"
    ),
    "howto": (
        "\nThis asks how to proceed. Numbered steps when it is a procedure, "
        "plain sentences when it is one thing to do. Each step is an action "
        "stated in the imperative, with a line under it only where the step is "
        "not self-evident. Six or seven steps is a procedure; fifteen is a "
        "manual nobody reads.\n"
    ),
}

_EXPRESS = (
    "\nBe brief. A short paragraph, or up to five bullets. Lead with the "
    "strongest evidence and leave out the marginal. Brief does not mean vague: "
    "a short answer that names the actual thing beats a long one that gestures "
    "at it.\n"
)

_ADVANCED = (
    "\nGo deeper. Cover each distinct theme the passages support, note where "
    "meetings disagree or where a position moved, and give dates where the "
    "sequence matters. Depth comes from the evidence: do not add a point, "
    "stretch a point, or repeat one in other words to make the answer longer. "
    "If the material supports three things, three is the answer.\n"
)

# Unchanged in substance from the brief that shipped before, because it was
# right: an inventory fails on writing rather than on evidence. Told to be
# concise, a model merges near-identical items and the reply is complete and
# uncountable.
_ENUMERATE = (
    "\nThis question asks for a complete list. Therefore:\n"
    "- Include EVERY item that matches. Not a representative sample, not the "
    "most important ones.\n"
    "- One bullet per item. Never combine two items into one bullet, even when "
    "they are near-identical, share an owner, or came from the same meeting. "
    "The reader is counting.\n"
    "- Keep each item recognisable as the item it came from; do not generalise "
    "several into a category.\n"
    "- Finish with a line of the form 'Total: N.'\n"
    "- If you cannot tell whether the list is complete, say so on that line "
    "rather than implying it is.\n"
)


def system_prompt(
    *,
    intent: str = "fact",
    depth: str = "express",
    exhaustive: bool = False,
    guidance: bool = False,
) -> str:
    """The brief for one answer.

    `exhaustive` is passed separately from `intent` rather than derived from it,
    because the two answer different questions: the intent is what the reader
    asked for, and exhaustive is whether this deployment's caller wants it
    counted. They agree in every current path and are still not the same thing.

    `guidance` is likewise the caller's decision rather than this module's. The
    router in `app.questions` decides it from the question; the answer is that
    the permission arrives here already made, so that the one place where an
    answer may reach past the user's own evidence is a single boolean somebody
    can grep for. Exactly one of the two policy blocks is always present — the
    permissive one is an *addition* to grounding, never a replacement, and
    leaving both out would be a prompt with no policy at all.

    Both modes get the same policy. Express is not a mode that answers worse: a
    procedural question asked in Express gets the same general next steps, more
    briefly. See `_EXPRESS` and `_ADVANCED`, which change length and breadth and
    nothing about what may be said.
    """
    parts = [_SHARED, _ANSWER_FIRST, _GROUNDING]
    parts.append(_GUIDANCE_ALLOWED if guidance else _MEETING_ONLY)
    parts.append(_INTENT.get(intent, _INTENT["fact"]))
    if exhaustive:
        parts.append(_ENUMERATE)
    else:
        parts.append(_ADVANCED if depth == "advanced" else _EXPRESS)
    parts.append(_FORMAT)
    parts.append(_CONTRACT)
    return "".join(parts)


def user_prompt(question: str, passages: list[str], history: list[str] | None = None) -> str:
    """The passages, the conversation so far, and the question.

    History is the user's own earlier turns and nothing else. "Which of those
    changed later?" is unanswerable without them — "those" refers to something
    said a minute ago — and the reference lives in what the *user* asked, not in
    what was answered. Feeding previous answers back would let one loose claim
    become the evidence for the next one, which is the failure mode where a
    grounded system quietly stops being grounded.
    """
    blocks: list[str] = []
    if history:
        blocks.append(
            "Earlier in this conversation the user asked:\n"
            + "\n".join(f"- {h}" for h in history)
            + "\nUse these only to understand what the current question refers "
            "to. They are not evidence."
        )
    numbered = "\n\n".join(f"[{i + 1}] {p}" for i, p in enumerate(passages))
    blocks.append(f"Passages:\n{numbered}")
    blocks.append(f"Question: {question}")
    return "\n\n".join(blocks)


MEETING_ONLY = "meeting_only"
MIXED = "meeting_plus_general_guidance"
_GROUNDING_VALUES = frozenset({MEETING_ONLY, MIXED})


@dataclass(frozen=True)
class Answer:
    """Prose, which passages it came from, and whether it stayed inside them.

    `used` empty means the model did not say — an older adapter, a mock, or a
    reply that failed to parse. The caller treats that as "all of them", which
    is what citations were before this field existed: no worse than the old
    behaviour, and never a claim that a passage was used when it is known it was
    not.

    `grounding` defaults to `MEETING_ONLY`, which is the conservative reading of
    silence: an answer that did not declare itself mixed is treated as a claim
    about the meetings, and every rule that applies to those applies to it. It
    is never shown to the reader — see `_CONTRACT` — and exists so the mixed
    answers can be counted in development and asserted in tests.
    """

    text: str
    used: tuple[int, ...] = ()
    grounding: str = MEETING_ONLY

    @property
    def mixed(self) -> bool:
        """Whether any part of this answer is general knowledge."""
        return self.grounding == MIXED


_JSON_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.IGNORECASE)


def parse(data: dict | str, passage_count: int) -> Answer:
    """Read the model's reply, tolerating the shapes it actually returns.

    A bare string is accepted because two callers can produce one: the mock
    adapter, and a JSON response that arrived with the prose at the top level.
    Passage numbers outside the range are dropped rather than clamped — a model
    citing [9] of five passages has miscounted, and clamping it to [5] would
    turn a miscount into a false citation.
    """
    if isinstance(data, str):
        return Answer(text=_JSON_FENCE.sub("", data).strip())

    text = data.get("answer")
    if not isinstance(text, str):
        text = ""
    used: list[int] = []
    for n in data.get("used") or []:
        try:
            i = int(n)
        except (TypeError, ValueError):
            continue
        if 1 <= i <= passage_count and i not in used:
            used.append(i)
    # An unrecognised label falls back to the strict reading rather than being
    # passed through. The field is a claim about how far the answer went, and a
    # claim we cannot interpret is not one to take the permissive side of.
    grounding = data.get("grounding")
    if grounding not in _GROUNDING_VALUES:
        grounding = MEETING_ONLY
    return Answer(text=text.strip(), used=tuple(used), grounding=grounding)
