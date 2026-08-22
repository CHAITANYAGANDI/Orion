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


# Commitments shown to the meeting's suggester. A handful: past this they stop
# adding distinct things to ask about and start adding tokens, and the chips
# only need to know that this meeting produced work.
_MAX_ITEMS = 6


def meeting_material(
    short_summary: str,
    sections: list[SummarySection],
    title: str = "",
    action_items: list[str] | None = None,
) -> str:
    """One meeting, rendered for the suggester.

    Sections rather than `detailed_summary`, because the headings are half the
    signal: a "Blockers" heading with three bullets under it tells the model
    there is something specific to ask about, where the same words flattened
    into prose read as more narrative.

    Action items are included because they are the one thing a summary cannot
    supply: it records what was said, never what somebody was left holding.
    "Status of the pricing follow-up?" is a question about this meeting that no
    amount of summary text suggests.

    Still bounded, and still not the transcript. Feeding two hours of speech in
    to produce three chips is the version of this that is expensive on every
    meeting and better on none: a transcript is mostly connective tissue, and a
    model asked to find something worth asking about in it reliably picks a
    vivid aside over the decision that took forty minutes.
    """
    parts: list[str] = []
    if title.strip():
        parts.append(f"Meeting: {title.strip()}")
    if short_summary.strip():
        parts.append(short_summary.strip())

    if action_items:
        kept = [t.strip() for t in action_items if t and t.strip()][:_MAX_ITEMS]
        if kept:
            parts.append("## Action items\n" + "\n".join(f"- {t}" for t in kept))

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


# --- what Home should ask ---------------------------------------------------- #
#
# Home is "ask across my meeting memory", and the chips there were the opposite
# of that. They were generated from whatever twelve meetings happened to be
# most recent, with a prompt asking the model to name real topics — so a user
# who had one product-marketing call last Tuesday was offered "Key product
# feature announcements?" and "Competitive messaging framework?" as their entry
# points into an archive of fifty unrelated meetings. Every chip was accurate.
# None of them was about the workspace.
#
# The fix is not to hard-code three questions forever, which fails the other
# way: the same three chips on every visit stop being read after the second.
# What is here is a hybrid. Signals the workspace actually has — overdue work,
# decisions on record, meetings clustering on one topic — produce questions
# deterministically, and the model fills what is left with something broad
# enough to be worth asking of an archive.

SUGGESTION_SLOTS = 3

# The floor, used when a workspace has signals for none of the slots. Broad on
# purpose: these are the questions that are worth asking of any archive, which
# is exactly what makes them poor when something better is available and
# adequate when nothing is.
STATIC_WORKSPACE = (
    "What changed recently?",
    "What still needs to be completed?",
    "What decisions were made recently?",
)


def signal_questions(
    *,
    overdue: int = 0,
    open_items: int = 0,
    decisions: int = 0,
    recurring: str | None = None,
) -> list[str]:
    """Workspace questions the workspace's own state justifies.

    Each is offered only when the thing it asks about exists. "What overdue
    commitments need attention?" on an archive with none is a chip that answers
    itself, and answering itself is how a suggestion teaches somebody the
    feature does not work.

    Order is by how likely the answer is to change what the reader does today:
    something already late first, then what is merely outstanding, then the
    record, then the theme.
    """
    out: list[str] = []
    if overdue > 0:
        out.append("What overdue commitments need attention?")
    elif open_items > 0:
        out.append("What still needs to be completed?")
    if decisions > 0:
        out.append("What decisions were made recently?")
    if recurring:
        # Bounded, because a chip is a chip: a project named after a sentence
        # would push the other two off the row.
        topic = recurring.strip()[:40]
        if topic:
            out.append(f"What changed in {topic} recently?")
    return out


def blend(signals: list[str], generated: list[str] | None) -> list[str]:
    """The three chips Home shows.

    Signals first, because they are grounded in a fact about the workspace
    rather than in a model's reading of twelve summaries. Generated ones fill
    what is left, the static floor fills what is still left, and the whole thing
    is deduplicated case-insensitively — the model, asked for workspace-level
    questions, quite reasonably proposes "What still needs to be completed?"
    itself, and offering it twice is worse than offering two chips.
    """
    out: list[str] = []
    seen: set[str] = set()
    for candidate in [*signals, *(generated or []), *STATIC_WORKSPACE]:
        text = (candidate or "").strip()
        key = text.lower().rstrip("?.")
        if not text or key in seen:
            continue
        seen.add(key)
        out.append(text)
        if len(out) == SUGGESTION_SLOTS:
            break
    return out
