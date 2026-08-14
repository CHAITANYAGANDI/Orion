"""What to show a model so it can propose good starter questions.

The chips above a chat are hard-coded today, and a fixed list is wrong in the
way that matters rather than the way that shows. "What did we decide?" appears
on a meeting that decided nothing; the same three chips appear on every meeting
a user opens, so after the second one they stop being read at all. A chip earns
its place by being about *this* material.

Generation itself is one prompt in the adapter. This module is the other half:
choosing what the model gets to look at, which turns out to be where the
quality actually comes from.

Two rules shape both builders below.

**Send the summary, not the transcript.** A transcript is mostly connective
tissue — greetings, restatements, someone's dog. Asked to find something worth
asking about, a model reading raw transcript reliably picks a vivid aside over
the decision that took forty minutes. The summary is already the meeting with
the filler removed, which is exactly the input this needs, and it is a fraction
of the tokens.

**Bound it hard.** These run per meeting and per workspace, so an unbounded
prompt is an unbounded bill on the archive of whoever has a thousand meetings.
The caps below are chosen to keep the material recognisable rather than
complete: three questions do not need the whole archive to be good.
"""

from __future__ import annotations

from datetime import datetime

from app.schemas import SummarySection

# --- one meeting ------------------------------------------------------------ #
# Bullets kept per section. Past a handful they stop adding distinct things to
# ask about and start adding tokens.
_MAX_BULLETS_PER_SECTION = 6
_MAX_MATERIAL_CHARS = 6000


def meeting_material(
    short_summary: str, sections: list[SummarySection], title: str = ""
) -> str:
    """One meeting, rendered for the suggester.

    Sections rather than `detailed_summary`, because the headings are half the
    signal: a "Blockers" heading with three bullets under it tells the model
    there is something specific to ask about, where the same words flattened
    into prose read as more narrative.
    """
    parts: list[str] = []
    if title.strip():
        parts.append(f"Meeting: {title.strip()}")
    if short_summary.strip():
        parts.append(short_summary.strip())

    for section in sections:
        # The outline is a chronological walkthrough of the whole meeting. It
        # is the largest section by far and the least useful here: questions
        # drawn from it come out as "what did Speaker 2 say at the start?".
        if section.key in ("outline", "quotes"):
            continue
        body: list[str] = []
        if section.kind == "prose" and section.text.strip():
            body.append(section.text.strip())
        elif section.bullets:
            body.extend(f"- {b}" for b in section.bullets[:_MAX_BULLETS_PER_SECTION])
        if body:
            parts.append(f"## {section.title}\n" + "\n".join(body))

    return "\n\n".join(parts)[:_MAX_MATERIAL_CHARS]


# --- the workspace ---------------------------------------------------------- #
# Recent meetings only. "What changed since last week" is a question about the
# last few meetings; a suggestion referring to something from March reads as a
# system that has lost track of what the user is doing.
MAX_MEETINGS = 12
_MAX_SUMMARY_CHARS = 400
MAX_OPEN_ITEMS = 12
_MAX_WORKSPACE_CHARS = 8000


def workspace_material(
    meetings: list[tuple[str, datetime | None, str | None]],
    open_items: list[tuple[str, str]] | None = None,
) -> str:
    """Recent meetings, and what is still outstanding across them.

    The action items are included because the most useful cross-meeting
    question a user has is usually about a promise rather than a topic, and
    that is the one thing summaries cannot supply — a summary records what was
    said, never what happened afterwards.

    Returns an empty string when there is nothing to work from, which is the
    signal to skip the model call entirely rather than ask it to invent
    questions about an empty archive.
    """
    lines: list[str] = []

    if meetings:
        lines.append("Recent meetings:")
        for title, created, summary in meetings[:MAX_MEETINGS]:
            when = created.date().isoformat() if isinstance(created, datetime) else ""
            head = f"- {title}" + (f" ({when})" if when else "")
            lines.append(head)
            if summary and summary.strip():
                lines.append(f"    {summary.strip()[:_MAX_SUMMARY_CHARS]}")

    if open_items:
        lines.append("")
        lines.append("Outstanding action items:")
        for item_title, meeting_title in open_items[:MAX_OPEN_ITEMS]:
            lines.append(f"- {item_title} (from: {meeting_title})")

    if not lines:
        return ""
    return "\n".join(lines)[:_MAX_WORKSPACE_CHARS]
