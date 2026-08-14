"""Reading a time window out of a question.

Workspace retrieval is semantic, which means "what changed since last week?"
matches on the words *changed* and *week* and then answers from whichever
passages happen to be nearest in embedding space — quite possibly three meetings
from March. The answer reads fluently and cites real quotes, and the one thing
the question actually asked for, that the evidence be recent, is the one thing
nothing enforced.

So the window is parsed out of the question and applied as a filter.

**Windows roll backwards from now; they are not calendar periods.** "Last week"
means the last seven days, not Monday-to-Sunday of the previous week. A calendar
reading would put yesterday's meeting outside "last week", which is never what
someone comparing recent work against older work means. The exceptions are
`today` and `yesterday`, which are genuinely calendar days — nobody says
"yesterday" meaning "the last 24 hours" — and named months.

**Comparison is a separate question from filtering.** "What changed since last
week?" needs both sides: the recent meetings *and* the ones before them, or
there is nothing to have changed from. "What did we discuss last week?" needs
only the window. The two are distinguished by the wording, because retrieving
the older half costs a second query and putting it in front of the model on a
question that did not ask for it invites an answer about the wrong period.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

# Rolling lengths, in days, for the bare phrases.
_WEEK = 7
_MONTH = 30
_QUARTER = 91

_MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11,
    "december": 12,
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7, "aug": 8,
    "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}

_UNIT_DAYS = {"day": 1, "week": 7, "month": 30, "year": 365}


@dataclass(frozen=True)
class Window:
    """A half-open interval `[start, end)` and how to describe it to the model.

    `end` is None for windows that run up to now, which is all of them except
    the calendar ones — leaving it open rather than pinning it to the current
    instant avoids excluding a meeting created seconds ago by a clock skew.
    """

    start: datetime
    end: datetime | None
    label: str
    #: True when the question asks how things *changed*, so the meetings before
    #: `start` are needed as the other half of the comparison.
    comparative: bool


def _midnight(when: datetime) -> datetime:
    return when.replace(hour=0, minute=0, second=0, microsecond=0)


# Phrases that make the question a comparison rather than a lookup. "Since" is
# included because "since last week" presupposes a before — the word does the
# work of asking for one.
_COMPARATIVE = re.compile(
    r"\b(chang(ed|es)|different|differ|compare[sd]?|comparison|versus|vs\.?"
    r"|since|progress|moved|update[sd]?|new(er)? than|still)\b",
    re.IGNORECASE,
)

# Ordered: the first match wins, so the more specific patterns come first.
# `last 3 weeks` must be tried before the bare `last week`, or the number is
# silently dropped and three weeks of evidence shrinks to seven days.
#
# The digit run is generous rather than tight, and the cap below is what keeps
# it safe. A narrow `\d{1,3}` would not match "the last 9000 months" at all, so
# the phrase would fall through to no window and the question would silently
# search the entire archive — the exact failure this module exists to prevent.
# Matching it and clamping it is the behaviour that degrades sensibly.
_EXPLICIT_N = re.compile(
    r"\b(?:last|past|previous|recent)\s+(\d{1,6})\s+(day|week|month|year)s?\b",
    re.IGNORECASE,
)
_MONTH_NAME = re.compile(
    r"\b(?:in|since|during|from)\s+("
    + "|".join(sorted(_MONTHS, key=len, reverse=True))
    + r")\b",
    re.IGNORECASE,
)

_PHRASES: list[tuple[re.Pattern[str], int, str]] = [
    (re.compile(r"\b(this|last|past|previous)\s+week\b", re.IGNORECASE), _WEEK, "the last 7 days"),
    (re.compile(r"\bthis\s+month\b", re.IGNORECASE), _MONTH, "the last 30 days"),
    (re.compile(r"\b(last|past|previous)\s+month\b", re.IGNORECASE), _MONTH, "the last 30 days"),
    (re.compile(r"\b(this|last|past|previous)\s+quarter\b", re.IGNORECASE), _QUARTER, "the last quarter"),
    (re.compile(r"\b(this|last|past|previous)\s+year\b", re.IGNORECASE), 365, "the last year"),
    (re.compile(r"\bfortnight\b", re.IGNORECASE), 14, "the last 14 days"),
    # Vague but common, and a vague window still beats no window: without it
    # "lately" retrieves from the whole archive.
    (re.compile(r"\b(recent(ly)?|lately|of late)\b", re.IGNORECASE), _MONTH, "the last 30 days"),
]


def detect_window(question: str, now: datetime | None = None) -> Window | None:
    """The time window the question is about, or None when it names no period.

    Returning None is the common case and the important one: most questions are
    not about a period, and inventing a window for them would hide most of the
    workspace from a question that meant to search all of it.
    """
    if not question:
        return None
    now = now or datetime.now(timezone.utc)
    comparative = bool(_COMPARATIVE.search(question))

    # "yesterday" / "today" are real calendar days, not rolling windows.
    if re.search(r"\byesterday\b", question, re.IGNORECASE):
        start = _midnight(now) - timedelta(days=1)
        return Window(start, _midnight(now), "yesterday", comparative)
    if re.search(r"\btoday\b", question, re.IGNORECASE):
        return Window(_midnight(now), None, "today", comparative)

    match = _EXPLICIT_N.search(question)
    if match:
        n = int(match.group(1))
        unit = match.group(2).lower()
        days = min(n * _UNIT_DAYS[unit], 365 * 5)
        plural = "" if n == 1 else "s"
        return Window(now - timedelta(days=days), None, f"the last {n} {unit}{plural}", comparative)

    match = _MONTH_NAME.search(question)
    if match:
        month = _MONTHS[match.group(1).lower()]
        # The most recent occurrence of that month: "since March" asked in
        # February means last March, not a March eleven months in the future.
        year = now.year if month <= now.month else now.year - 1
        start = datetime(year, month, 1, tzinfo=now.tzinfo or timezone.utc)
        # "since March" runs to now; "in March" is that month alone.
        open_ended = bool(re.search(r"\bsince\b", question, re.IGNORECASE))
        if open_ended:
            return Window(start, None, f"{match.group(1).title()} onwards", comparative)
        end = (
            datetime(year + 1, 1, 1, tzinfo=start.tzinfo)
            if month == 12
            else datetime(year, month + 1, 1, tzinfo=start.tzinfo)
        )
        return Window(start, end, f"{match.group(1).title()} {year}", comparative)

    for pattern, days, label in _PHRASES:
        if pattern.search(question):
            return Window(now - timedelta(days=days), None, label, comparative)

    return None
