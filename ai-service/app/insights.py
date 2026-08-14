"""Decisions and risks, derived from the summary that was already written.

There is an obvious way to build this and it is the wrong one: ask the model a
second time, "list the decisions in this transcript". That produces a list which
disagrees with the summary sitting next to it on the page — same transcript, two
passes, two readings — and a reader has no way to tell which one to believe. It
also costs a second call per meeting for information the first call already
produced.

So these are *read* from the summary rather than re-extracted. Whatever the
Decisions section says is what the decision store holds, which means the two
surfaces can never contradict each other and correcting one corrects both.

The consequence, stated plainly: a template with no decision-shaped section
yields no decisions. 1:1 and Interview are the two, and that is right rather
than a gap — a 1:1 produces commitments (already action items) and an interview
produces observations. Neither settles anything.

Which sections count is a judgement about the instruction each was written with,
not about its title:

* `selected` (Brainstorm) is "the ideas the group **chose** to take forward"
* `improvements` (Retrospective) is "changes the team **agreed** to try"

Both are decisions in everything but name. `commitments` (1:1) is deliberately
excluded: those are tasks with an owner, which is what action items already are,
and duplicating them here would double-count every promise in the workspace.
"""

from __future__ import annotations

import re

from app.schemas import Insight, SummarySection

# Sections whose bullets are things the meeting settled.
DECISION_KEYS = frozenset({"decisions", "selected", "improvements"})

# Sections whose bullets are things that might go wrong. `blockers` is already
# happening and `risks` might; they are stored together because a reader
# scanning for trouble wants both, and the section they came from is kept so the
# distinction is not lost.
RISK_KEYS = frozenset({"risks", "blockers", "concerns"})

# A bullet has to carry some content to be worth storing as a standalone row.
_MIN_CHARS = 8

# Models are told to return an empty list when a section had nothing, and mostly
# do — but "No blockers were raised." comes back often enough to matter, and it
# is the one bullet that must not be stored. As a row it renders as a risk
# called "no risks", and in workspace chat it becomes a decision to compare
# against other decisions.
#
# Matched narrowly on purpose: an anchored prefix plus a length ceiling, so a
# real decision that happens to open with "None of the vendors met the security
# bar, so we chose Acme" is far too long to be caught by it.
_NOTHING = re.compile(
    r"^\s*(no|none|nothing|n/?a|not applicable)\b"
    r"|^\s*(there (were|was) no|no \w+ (were|was) (raised|identified|made|named|discussed))",
    re.IGNORECASE,
)
_NOTHING_MAX_CHARS = 60


def _is_placeholder(text: str) -> bool:
    """A bullet that says the section is empty, rather than filling it."""
    return len(text) <= _NOTHING_MAX_CHARS and bool(_NOTHING.search(text))


def derive_insights(sections: list[SummarySection]) -> list[Insight]:
    """Pull decisions and risks out of the sections the summarizer wrote.

    Order follows the template, so the store reads in the same order as the page
    it came from. Duplicates are dropped case-insensitively: Project Review has
    both Risks and Blockers, and a team that names the same dependency in both
    should not get two rows out of it.
    """
    out: list[Insight] = []
    seen: set[tuple[str, str]] = set()

    for section in sections:
        if section.key in DECISION_KEYS:
            kind = "DECISION"
        elif section.key in RISK_KEYS:
            kind = "RISK"
        else:
            continue

        # Only bullet sections carry a list of discrete items. A prose section
        # under one of these keys would be one paragraph, not a set of rows, and
        # storing it whole would put an essay in a chip.
        if section.kind != "bullets":
            continue

        for bullet in section.bullets:
            text = (bullet or "").strip()
            if len(text) < _MIN_CHARS or _is_placeholder(text):
                continue
            key = (kind, text.casefold())
            if key in seen:
                continue
            seen.add(key)
            out.append(Insight(kind=kind, text=text, source_section=section.key))

    return out
