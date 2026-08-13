"""Built-in summary templates.

A template is an ordered list of sections, each with its own instruction. The
shape matters as much as the wording: a meeting is read in two different ways
and the sections serve them separately.

*Overview* answers "what came out of this" — decisions, outcomes, what is due.
*Outline* answers "what happened, in order" — a walkthrough that makes a long
recording navigable, and the one place where naming who said what is right,
because the reader is using it to find a moment rather than to learn a fact.

Writing one section in the other's voice is what makes notes feel thin: an
overview that narrates who spoke states nothing, and an outline that only
states conclusions cannot be scanned for a moment you half-remember.

Defined here rather than only in SQL so the wording lives with the prompts it
shapes; the migration seeds the same set for the picker to list.
"""

from __future__ import annotations

from app.schemas import SummaryTemplate, TemplateSection

_OVERVIEW = TemplateSection(
    key="overview",
    title="Overview",
    kind="prose",
    instruction=(
        "One paragraph of 4-6 sentences on what the meeting was for, what was "
        "settled, and what is due. Write about the substance, never about the "
        "conversation: name decisions and outcomes, not who discussed what. "
        "Keep the concrete details — product names, dates, deadlines, chosen "
        "wording quoted exactly."
    ),
)

_OUTLINE = TemplateSection(
    key="outline",
    title="Outline",
    kind="outline",
    instruction=(
        "A chronological walkthrough, grouped under short topic headings in "
        "the order the meeting covered them. Four to eight headings, each with "
        "3-5 bullets. Here — and only here — name the speakers, because this "
        "section is used to find a moment in the recording: 'Speaker 1 asks "
        "about the time frame, and Speaker 2 explains it mirrors the GitLab 14 "
        "launch'. Cover the whole meeting, including the closing."
    ),
)

_KEY_POINTS = TemplateSection(
    key="keyPoints",
    title="Key points",
    kind="bullets",
    instruction=(
        "6-10 bullets, each a decision, commitment or concrete fact that "
        "stands on its own, with the owner and deadline where the transcript "
        "gives them."
    ),
)


_NEXT_STEPS = TemplateSection(
    key="nextSteps",
    title="Next steps",
    kind="bullets",
    instruction=(
        "3-6 bullets on what happens after this meeting. Distinct from the "
        "action items: those are tasks with an owner, these are the state of "
        "play — what is now unblocked, what is waiting on whom, what the next "
        "checkpoint is. Say 'nothing was agreed' rather than inventing one if "
        "the meeting ended without a forward plan."
    ),
)

_QUOTES = TemplateSection(
    key="quotes",
    title="Key quotations",
    kind="bullets",
    instruction=(
        "3-6 lines worth carrying into a readout, each reproduced EXACTLY as "
        "spoken — copy the words from the transcript, do not tidy grammar, "
        "shorten, merge two sentences, or paraphrase. A line that cannot be "
        "copied verbatim must be left out. Do not add speaker names or "
        "timestamps; those are attached afterwards from the transcript itself."
    ),
)


def _template(slug: str, name: str, *extra: TemplateSection) -> SummaryTemplate:
    """Every template opens with an Overview and closes the same way.

    The middle is what makes each one different. Keeping the ends fixed means
    switching template never loses the summary someone was relying on — it
    changes what is added around it.

    Next steps and quotations sit in that fixed spine because they are useful
    for every kind of meeting, and because quotations in particular are only
    trustworthy when they go through the verification in `app.quotes` — which
    they do exactly once, here, rather than per template.
    """
    return SummaryTemplate(
        slug=slug,
        name=name,
        sections=[_OVERVIEW, *extra, _NEXT_STEPS, _QUOTES, _OUTLINE],
    )


BUILT_IN: list[SummaryTemplate] = [
    _template("general", "General", _KEY_POINTS),
    _template(
        "team-meeting",
        "Team Meeting",
        _KEY_POINTS,
        TemplateSection(
            key="blockers",
            title="Blockers and dependencies",
            kind="bullets",
            instruction=(
                "Anything stated as blocking progress or waiting on someone "
                "else, with who is waiting and on what. Empty list if none."
            ),
        ),
    ),
    _template(
        "one-on-one",
        "1:1",
        TemplateSection(
            key="topics",
            title="Topics raised",
            kind="bullets",
            instruction="What the person brought up, in their framing, one bullet each.",
        ),
        TemplateSection(
            key="feedback",
            title="Feedback exchanged",
            kind="bullets",
            instruction=(
                "Feedback given or received, in either direction, attributed. "
                "Empty list if none was exchanged."
            ),
        ),
        TemplateSection(
            key="growth",
            title="Growth and career",
            kind="bullets",
            instruction=(
                "Anything about development, progression, or longer-term "
                "goals. Empty list if the conversation stayed operational."
            ),
        ),
    ),
    _template(
        "candidate-interview",
        "Candidate Interview",
        TemplateSection(
            key="background",
            title="Background",
            kind="bullets",
            instruction="The candidate's stated experience, roles and relevant history.",
        ),
        TemplateSection(
            key="strengths",
            title="Strengths demonstrated",
            kind="bullets",
            instruction=(
                "Specific evidence from their answers, each tied to what they "
                "actually said rather than an impression."
            ),
        ),
        TemplateSection(
            key="concerns",
            title="Concerns and gaps",
            kind="bullets",
            instruction=(
                "Anything raised as a reservation, or a question answered "
                "thinly. Report only what the transcript supports — never "
                "infer a judgement nobody voiced."
            ),
        ),
        TemplateSection(
            key="candidateQuestions",
            title="Questions the candidate asked",
            kind="bullets",
            instruction="What they wanted to know, which shows what they care about.",
        ),
    ),
    _template(
        "sales-discovery",
        "Sales - Discovery",
        TemplateSection(
            key="painPoints",
            title="Pain points",
            kind="bullets",
            instruction="Problems the prospect described, in their own words where possible.",
        ),
        TemplateSection(
            key="currentStack",
            title="Current stack and process",
            kind="bullets",
            instruction="Tools, vendors and workflows they said they use today.",
        ),
        TemplateSection(
            key="requirements",
            title="Requirements",
            kind="bullets",
            instruction="What they said a solution must do, including any stated constraints.",
        ),
    ),
    _template(
        "sales-bant",
        "Sales - BANT",
        TemplateSection(
            key="budget",
            title="Budget",
            kind="bullets",
            instruction=(
                "What was said about budget, spend or cost. Say plainly that "
                "budget was not discussed rather than inferring a figure."
            ),
        ),
        TemplateSection(
            key="authority",
            title="Authority",
            kind="bullets",
            instruction="Who decides, who else must approve, and how they described the process.",
        ),
        TemplateSection(
            key="need",
            title="Need",
            kind="bullets",
            instruction="The problem they are trying to solve and why it matters to them now.",
        ),
        TemplateSection(
            key="timing",
            title="Timing",
            kind="bullets",
            instruction="Dates, deadlines, renewal windows or events driving the timeline.",
        ),
    ),
    _template(
        "team-standup",
        "Team Standup",
        TemplateSection(
            key="perPerson",
            title="Per person",
            kind="outline",
            instruction=(
                "One heading per participant, bullets under each for what they "
                "reported: done, in progress, and anything blocking them."
            ),
        ),
    ),
    _template(
        "user-research-interview",
        "User Research Interview",
        TemplateSection(
            key="behaviours",
            title="Observed behaviour",
            kind="bullets",
            instruction=(
                "What the participant said they actually do today, as distinct "
                "from what they say they want."
            ),
        ),
        TemplateSection(
            key="frustrations",
            title="Frustrations",
            kind="bullets",
            instruction="Friction they described, quoting their phrasing where it is vivid.",
        ),
    ),
]

DEFAULT_SLUG = "general"

BY_SLUG: dict[str, SummaryTemplate] = {t.slug: t for t in BUILT_IN}


def resolve(slug: str | None) -> SummaryTemplate:
    """The named template, falling back to General for an unknown slug.

    Unknown rather than invalid: a template deleted after a meeting was
    summarized should still produce notes, not an error.
    """
    return BY_SLUG.get(slug or DEFAULT_SLUG, BY_SLUG[DEFAULT_SLUG])
