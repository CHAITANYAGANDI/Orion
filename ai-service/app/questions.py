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
