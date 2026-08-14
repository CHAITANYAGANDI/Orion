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

THE SET
    Eight templates, drawn from two places. General, Detailed, Executive, Memo,
    Standup and Interview follow Summary.ai's shapes; 1:1 and Team Meeting
    follow Otter's.

    Summary.ai also offers a "Meeting" template, which is deliberately absent.
    In a product where every input *is* a meeting, "Meeting" and "General" are
    the same template with two names, and a picker that offers both makes the
    user choose between synonyms. General is the one kept, because it is also
    the fallback for an unknown slug and so has to exist regardless.

    The three that vary by *depth* rather than by kind — General, Detailed,
    Executive — are worth keeping apart even though their sections overlap:
    the same meeting genuinely needs a different summary for the person
    catching up, the person reconstructing it, and the person approving it.
    That difference lives in the section wording below, not in the headings.

Defined here rather than duplicated in the backend so the wording lives with
the prompts it shapes. There is no templates table: Spring serves this list
through, and a second copy would drift from the one the prompt is built from.
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

# The decision section, shared by every template that tracks decisions. Shared
# rather than repeated because `app.insights` reads these bullets into the
# decision record, and four near-identical instructions would give four
# different standards for what counts as a decision.
_DECISIONS = TemplateSection(
    key="decisions",
    title="Decisions",
    kind="bullets",
    instruction=(
        "Each decision the meeting actually settled, stated as the outcome "
        "rather than the debate, and attributed where the transcript says who "
        "decided. A question left open is not a decision — leave it out and "
        "let Next steps carry it. Empty list when nothing was settled, which "
        "is common and fine."
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
    # --- the three that vary by depth -------------------------------------- #
    _template(
        "general",
        "General",
        _DECISIONS,
    ),
    _template(
        "detailed",
        "Detailed",
        TemplateSection(
            key="keyPoints",
            title="Key points",
            kind="bullets",
            instruction=(
                "8-12 bullets, each a decision, commitment or concrete fact "
                "that stands on its own, with the owner and deadline where the "
                "transcript gives them. This is the long form: prefer keeping a "
                "detail that might matter over a tidy list. A reader chose this "
                "template because they intend to reconstruct the meeting."
            ),
        ),
        _DECISIONS,
        TemplateSection(
            key="risks",
            title="Risks",
            kind="bullets",
            instruction=(
                "What was named as likely to go wrong or still unknown, "
                "including dependencies outside the group. Empty list if none "
                "was raised — an invented risk sends people chasing a problem "
                "that does not exist."
            ),
        ),
        TemplateSection(
            key="openQuestions",
            title="Open questions",
            kind="bullets",
            instruction=(
                "Questions raised and left unresolved, with who needs to "
                "resolve each. A question someone answered in the meeting does "
                "not belong here."
            ),
        ),
    ),
    _template(
        "executive",
        "Executive",
        TemplateSection(
            key="impact",
            title="Impact",
            kind="bullets",
            instruction=(
                "3-5 bullets on what this changes for the business: cost, "
                "timeline, scope, customers, headcount. Stated as consequences, "
                "not as activity — 'launch moves to March, two weeks of "
                "engineering re-planned', never 'the team discussed the "
                "timeline'. Say plainly when the meeting had no material "
                "impact rather than inflating one."
            ),
        ),
        _DECISIONS,
        TemplateSection(
            key="risks",
            title="Risks",
            kind="bullets",
            instruction=(
                "What could still go wrong, worst first, each with its "
                "consequence where the meeting gave one. Written for a reader "
                "who was not there and will not listen to the recording."
            ),
        ),
        TemplateSection(
            key="asks",
            title="Asks",
            kind="bullets",
            instruction=(
                "What the meeting needs from someone senior: a decision, a "
                "budget, an escalation, a name. This is the section an "
                "executive reads first, so it must contain only things "
                "genuinely asked for in the meeting. Empty list when nothing "
                "was."
            ),
        ),
    ),
    # --- specific shapes ---------------------------------------------------- #
    _template(
        "memo",
        "Memo",
        TemplateSection(
            key="purpose",
            title="Purpose",
            kind="prose",
            instruction=(
                "Two or three sentences stating what this memo is about and "
                "who needs to read it, in the register of a written memo rather "
                "than of meeting notes. Do not mention the meeting, the "
                "recording, or the speakers."
            ),
        ),
        TemplateSection(
            key="background",
            title="Background",
            kind="bullets",
            instruction=(
                "What a reader needs to know before the discussion makes "
                "sense: prior decisions, constraints, and how the situation "
                "arose. Only background the meeting actually supplied."
            ),
        ),
        TemplateSection(
            key="discussion",
            title="Discussion",
            kind="bullets",
            instruction=(
                "The options weighed and the argument for and against each. "
                "Unlike every other template, the reasoning is the point here "
                "rather than the conclusion — a memo exists to let a reader "
                "disagree with how the group got there."
            ),
        ),
        TemplateSection(
            key="recommendation",
            title="Recommendation",
            kind="bullets",
            instruction=(
                "What the memo proposes, with the reason for each proposal. "
                "A recommendation is not a decision: if the group settled it, "
                "say so plainly rather than restating it as a proposal."
            ),
        ),
    ),
    _template(
        "standup",
        "Standup",
        TemplateSection(
            key="yesterday",
            title="Yesterday",
            kind="bullets",
            instruction=(
                "What each person reported finishing or moving forward since "
                "the last standup. One bullet per person, named."
            ),
        ),
        TemplateSection(
            key="today",
            title="Today",
            kind="bullets",
            instruction=(
                "What each person said they will work on next. One bullet per "
                "person, named."
            ),
        ),
        TemplateSection(
            key="blockers",
            title="Blockers",
            kind="bullets",
            instruction=(
                "Anything stated as blocking someone, with who is blocked and "
                "on what or whom. Empty list when nobody raised one — an "
                "invented blocker sends people chasing a problem that does not "
                "exist."
            ),
        ),
    ),
    _template(
        "interview",
        "Interview",
        TemplateSection(
            key="questionsAndResponses",
            title="Questions and responses",
            kind="outline",
            instruction=(
                "One heading per question the interviewer asked, in the words "
                "they asked it, with the candidate's answer summarised beneath "
                "in 2-4 bullets. Keep the candidate's own framing and specific "
                "claims — numbers, technologies, timelines — rather than "
                "smoothing them into a verdict."
            ),
        ),
        TemplateSection(
            key="observations",
            title="Observations",
            kind="bullets",
            instruction=(
                "What the transcript supports about how the candidate "
                "answered: what they demonstrated, where they hesitated, what "
                "they asked about. Report only what was said. Do not score, "
                "rank, or recommend — an assessment invented from a transcript "
                "is a hiring decision made by something that was not in the "
                "room."
            ),
        ),
    ),
    _template(
        "one-on-one",
        "1:1",
        TemplateSection(
            key="topics",
            title="Topics",
            kind="bullets",
            instruction=(
                "What was brought up, in the framing the person used rather "
                "than a manager's summary of it."
            ),
        ),
        TemplateSection(
            key="feedback",
            title="Feedback",
            kind="bullets",
            instruction=(
                "Feedback given or received, in either direction, attributed. "
                "Empty list when none was exchanged."
            ),
        ),
        TemplateSection(
            key="commitments",
            title="Commitments",
            kind="bullets",
            instruction=(
                "What either person committed to, with the owner and timing "
                "where stated. Only commitments someone actually made — not "
                "ideas that were merely discussed."
            ),
        ),
    ),
    _template(
        "team-meeting",
        "Team Meeting",
        TemplateSection(
            key="progress",
            title="Progress",
            kind="bullets",
            instruction=(
                "What moved since the last time the team met, organised per "
                "person or per workstream as the meeting itself was organised. "
                "Stated as completed work rather than as activity."
            ),
        ),
        _DECISIONS,
        TemplateSection(
            key="openItems",
            title="Open items",
            kind="bullets",
            instruction=(
                "Questions raised and left unresolved, with who needs to "
                "resolve them. This is the section people come back for."
            ),
        ),
    ),
]

DEFAULT_SLUG = "general"

BY_SLUG: dict[str, SummaryTemplate] = {t.slug: t for t in BUILT_IN}


def resolve(slug: str | None) -> SummaryTemplate:
    """The named template, falling back to General for an unknown slug.

    Unknown rather than invalid: a template deleted after a meeting was
    summarized should still produce notes, not an error. This release removes
    five templates, so that path is live rather than theoretical.
    """
    return BY_SLUG.get(slug or DEFAULT_SLUG, BY_SLUG[DEFAULT_SLUG])
