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

## Why the reply is JSON

Citations used to be every passage retrieval returned, which asserts the model
read all of them and quoted all of them — neither true. Asking for the passage
numbers it actually used costs one field and makes the citation list mean
something. `answer` is still prose; only the envelope is structured.
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
    "Do not ask the reader to narrow the question when a reasonable answer can "
    "be given from what you have. Answer the most reasonable reading. Ask a "
    "question back only when the question has no reasonable reading at all.\n"
    "Do not end with an offer of further help. When the answer is finished, "
    "stop.\n"
)

_GROUNDING = (
    "\nGROUNDING — none of this relaxes for the sake of a better-reading "
    "answer:\n"
    "- Use only the passages. Never invent a fact, a name, an owner, a date, a "
    "number or a decision.\n"
    "- An action item's stated status is current. DONE is done, whatever a "
    "transcript said at the time.\n"
    "- Where two statements conflict, the later dated one holds. Say which is "
    "current.\n"
    "- If the passages genuinely do not answer the question, say so in one "
    "sentence and name the closest thing they do cover. Do not list meeting "
    "titles as a consolation prize, and do not pad with what you almost "
    "found.\n"
)

_FORMAT = (
    "\nSHAPE:\n"
    "- Plain sentences for a short answer. Bullets only when there are several "
    "genuinely distinct items.\n"
    "- A bold lead-in on a bullet only when it has a label and a body.\n"
    "- No headings unless the answer has three or more distinct parts.\n"
    "- Name the meeting a claim came from only when which meeting it was "
    "matters.\n"
    "- No preamble. No restating the question.\n"
)

_CONTRACT = (
    '\nReturn JSON: {"answer": "...", "used": [1, 4]}\n'
    "`answer` is the prose the reader sees, in markdown. `used` is the numbers "
    "of the passages you actually relied on — the ones whose content is in your "
    "answer. Do not list a passage you did not use; the reader is shown those "
    "passages as sources and clicking one that is not in the answer is a broken "
    "promise. If you used none because none were relevant, return an empty "
    "list.\n"
)

# What each kind of question wants the answer to look like. The router in
# `app.questions` picks one; none of them decides what is true.
_INTENT = {
    "fact": (
        "\nThis is a lookup. One or two sentences unless the answer genuinely "
        "has parts. Give the answer, then only the support that makes it "
        "checkable.\n"
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
        "else: no preamble, no notes on your sources, no count at the end. It "
        "still contains only what the passages support.\n"
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


def system_prompt(*, intent: str = "fact", depth: str = "express", exhaustive: bool = False) -> str:
    """The brief for one answer.

    `exhaustive` is passed separately from `intent` rather than derived from it,
    because the two answer different questions: the intent is what the reader
    asked for, and exhaustive is whether this deployment's caller wants it
    counted. They agree in every current path and are still not the same thing.
    """
    parts = [_SHARED, _ANSWER_FIRST, _GROUNDING]
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


@dataclass(frozen=True)
class Answer:
    """Prose, and which passages it came from.

    `used` empty means the model did not say — an older adapter, a mock, or a
    reply that failed to parse. The caller treats that as "all of them", which
    is what citations were before this field existed: no worse than the old
    behaviour, and never a claim that a passage was used when it is known it was
    not.
    """

    text: str
    used: tuple[int, ...] = ()


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
    return Answer(text=text.strip(), used=tuple(used))
