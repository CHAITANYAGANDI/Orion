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
    _template(
        "general",
        "General Meeting",
        TemplateSection(
            key="decisions",
            title="Decisions",
            kind="bullets",
            instruction=(
                "Each decision the meeting actually settled, stated as the "
                "outcome rather than the debate, and attributed where the "
                "transcript says who decided. A question left open is not a "
                "decision — leave it out and let Next steps carry it."
            ),
        ),
    ),
    _template(
        "daily-standup",
        "Daily Stand-up",
        TemplateSection(
            key="yesterday",
            title="Yesterday",
            kind="bullets",
            instruction=(
                "What each person reported finishing or moving forward since "
                "the last stand-up. One bullet per person, named."
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
        "sprint-planning",
        "Sprint Planning",
        TemplateSection(
            key="stories",
            title="Stories",
            kind="bullets",
            instruction=(
                "One bullet per story or ticket taken into the sprint, each "
                "carrying its owner and estimate in the same bullet as the "
                "story they belong to. Separate lists of stories, owners and "
                "estimates cannot be lined back up by a reader. Say plainly "
                "when an owner or estimate was not stated rather than guessing "
                "one."
            ),
        ),
        TemplateSection(
            key="risks",
            title="Risks and unknowns",
            kind="bullets",
            instruction=(
                "What the team named as likely to go wrong or still unknown, "
                "including dependencies outside the team. Empty list if none "
                "was raised."
            ),
        ),
    ),
    _template(
        "one-on-one",
        "1:1 Meeting",
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
        "project-review",
        "Project Review",
        TemplateSection(
            key="progress",
            title="Progress",
            kind="bullets",
            instruction=(
                "What has moved since the last review, stated as completed "
                "work rather than as activity."
            ),
        ),
        TemplateSection(
            key="risks",
            title="Risks",
            kind="bullets",
            instruction=(
                "Threats to the plan that were named, with their likely impact "
                "where it was discussed. Empty list if none was raised."
            ),
        ),
        TemplateSection(
            key="blockers",
            title="Blockers",
            kind="bullets",
            instruction=(
                "What is stopping work right now, and who or what it waits on. "
                "Distinct from a risk: a blocker is already happening."
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
                "One heading per question the interviewer asked, worded as it "
                "was asked, with the candidate's answer as the bullets beneath "
                "it. Paired this way deliberately: a list of questions and a "
                "separate list of answers cannot be matched back up by anyone "
                "reading them later."
            ),
        ),
        TemplateSection(
            key="observations",
            title="Observations",
            kind="bullets",
            instruction=(
                "What the answers showed, each tied to something the candidate "
                "actually said. Never infer a judgement nobody voiced, and "
                "never score the candidate — report the evidence and leave the "
                "conclusion to the reader."
            ),
        ),
    ),
    _template(
        "brainstorm",
        "Brainstorm",
        TemplateSection(
            key="ideas",
            title="Ideas raised",
            kind="bullets",
            instruction=(
                "Every distinct idea put forward, including the ones dismissed. "
                "A record that keeps only the winners destroys the reason the "
                "others were set aside, which is the thing people come back for."
            ),
        ),
        TemplateSection(
            key="themes",
            title="Themes",
            kind="bullets",
            instruction=(
                "The groupings the ideas fall into, named. Empty list when the "
                "ideas did not cluster into anything."
            ),
        ),
        TemplateSection(
            key="selected",
            title="Selected ideas",
            kind="bullets",
            instruction=(
                "The ideas the group chose to take forward, with the reason "
                "given for each. Empty list when nothing was selected — say "
                "that rather than promoting whichever idea got the most airtime."
            ),
        ),
    ),
    _template(
        "client-meeting",
        "Client Meeting",
        TemplateSection(
            key="requirements",
            title="Requirements",
            kind="bullets",
            instruction=(
                "What the client said they need, in their own words where the "
                "phrasing matters, separating firm requirements from "
                "preferences wherever they said which was which."
            ),
        ),
        TemplateSection(
            key="concerns",
            title="Concerns",
            kind="bullets",
            instruction=(
                "Objections, hesitations and risks the client raised, however "
                "lightly. A concern mentioned once and moved past is still the "
                "thing that stalls a deal, so record it."
            ),
        ),
    ),
    _template(
        "retrospective",
        "Retrospective",
        TemplateSection(
            key="wentWell",
            title="What went well",
            kind="bullets",
            instruction=(
                "What the team said worked, attributed where someone credited "
                "a person or a change."
            ),
        ),
        TemplateSection(
            key="didntGoWell",
            title="What didn't go well",
            kind="bullets",
            instruction=(
                "What the team said did not work. Report the problem as it was "
                "described, without softening it and without assigning blame "
                "the team did not assign."
            ),
        ),
        TemplateSection(
            key="improvements",
            title="Improvements to try",
            kind="bullets",
            instruction=(
                "Changes the team agreed to try, with an owner where one was "
                "named. Only agreed changes — a suggestion nobody took up "
                "belongs under what didn't go well, not here."
            ),
        ),
    ),
    _template(
        "weekly-sync",
        "Weekly Sync",
        TemplateSection(
            key="progress",
            title="Progress",
            kind="bullets",
            instruction=(
                "What moved this week, organised per person or per workstream "
                "as the meeting itself was organised."
            ),
        ),
        TemplateSection(
            key="decisions",
            title="Decisions",
            kind="bullets",
            instruction=(
                "What was settled, stated as the outcome. Empty list when the "
                "sync decided nothing, which is common and fine."
            ),
        ),
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
    summarized should still produce notes, not an error.
    """
    return BY_SLUG.get(slug or DEFAULT_SLUG, BY_SLUG[DEFAULT_SLUG])
