/**
 * Fallback starter prompts for the two grounded chats.
 *
 * **These are the floor, not the feature.** Both chats now show questions
 * generated from the actual material — this meeting's summary, or the user's
 * recent meetings — because a fixed list fails in the way that does not look
 * like a failure: "What did we decide?" sits on a meeting that decided nothing,
 * and the same three chips on every page stop being read after the second one.
 *
 * This set is what shows when there is nothing to generate from: a meeting
 * still processing, a brand-new workspace, a summary too thin to ask anything
 * specific about, or an ai-service outage. Kept hand-written rather than
 * replaced with something generic, because in exactly those moments the user
 * has the least context and the prompts have to carry the most.
 *
 * Split by what each chat can actually retrieve, which is the whole point of
 * having two lists. Meeting chat is grounded in one transcript, so "compare
 * these three meetings" has nothing to reach for and would produce a confident
 * answer from a single meeting's chunks — the worst failure a RAG surface has.
 * Workspace chat searches every meeting, so the single-meeting shortcuts
 * ("summarize this meeting") are the ones that make no sense there.
 *
 * Kept as data rather than inline JSX so the two panels cannot drift apart, and
 * so the wording is reviewable in one place.
 */

export interface ChatPrompt {
  /** What the user sees on the chip. */
  label: string;
  /** What is actually sent — fuller than the label, to steer retrieval. */
  prompt: string;
}

/** How many chips a chat shows at once. See `useRotatingPrompts`. */
export const SUGGESTION_ROW = 3;

/**
 * Everything this chat could offer, best first.
 *
 * A generated question is one string used for both the label and the prompt:
 * it is already specific and already short (the generator caps it), so the
 * label/prompt split that the static set needs — short chip, fuller prompt to
 * steer retrieval — has nothing to do here.
 *
 * ## Why this is a pool rather than a row
 *
 * It used to return either the generated questions or, when there were none,
 * the whole static list — which meant a meeting still processing showed seven
 * chips and the workspace showed six, where the design is three. Worse, the
 * three never changed: a meeting's suggestions are generated once when it is
 * processed, so the same row sat there for ever.
 *
 * So this returns the pool and `useRotatingPrompts` takes three off it,
 * advancing each visit. The static prompts are appended rather than replaced,
 * which is what gives a meeting processed before the pool existed — three
 * stored questions and nothing else — something to rotate through at all.
 *
 * Order is preference, not cosmetics: generated first, because they name the
 * actual meeting, and the hand-written ones behind them because they would sit
 * on any meeting ever recorded. Deduplicated case-insensitively, since a
 * generated "What did we decide?" and the static one are the same chip twice.
 */
export function toPrompts(
  generated: string[] | undefined | null,
  fallback: ChatPrompt[],
): ChatPrompt[] {
  const pool: ChatPrompt[] = [];
  const seen = new Set<string>();

  for (const p of [
    ...(generated ?? []).map((q) => q.trim()).filter(Boolean).map((q) => ({ label: q, prompt: q })),
    ...fallback,
  ]) {
    const key = p.label.toLowerCase().replace(/[?.\s]+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(p);
  }
  return pool;
}

/** Grounded in one transcript. */
export const MEETING_PROMPTS: ChatPrompt[] = [
  {
    label: "Summarize this meeting",
    prompt: "Summarize this meeting.",
  },
  {
    label: "What did we decide?",
    prompt: "What did we decide in this meeting? List each decision and who made it.",
  },
  {
    label: "What deadlines were discussed?",
    prompt: "What deadlines, dates or timelines were discussed, and what is due on each?",
  },
  {
    label: "Who promised what?",
    prompt:
      "Who committed to what in this meeting? List each commitment with the person who made it.",
  },
  {
    label: "Unresolved questions",
    prompt:
      "List the questions raised in this meeting that were not answered or resolved.",
  },
  {
    label: "Agenda for next time",
    prompt:
      "Based on what was left open in this meeting, draft an agenda for the next one.",
  },
];

/**
 * Grounded in one project's meetings.
 *
 * <p>Deliberately the questions you ask of a body of work rather than of a
 * conversation: where it stands, what is late, what changed. A project is
 * several meetings over weeks, so the useful questions are the ones no single
 * meeting can answer — which is the reason for scoping a chat to it at all.
 *
 * <p>No generated set behind these yet: the suggestion generator reads the
 * whole workspace and would propose questions about meetings that are not in
 * this project, which reads worse than a fixed list that is at least always
 * answerable here.
 */
export const PROJECT_PROMPTS: ChatPrompt[] = [
  {
    label: "Where does this project stand?",
    prompt:
      "Summarize where this project stands: what has been decided, what is in progress, and what is still open.",
  },
  {
    label: "What's outstanding?",
    prompt:
      "What was committed to in this project's meetings that does not appear to have been completed? Say who owns each.",
  },
  {
    label: "Every decision so far",
    prompt: "List every decision made across this project's meetings, in order, with when it was made.",
  },
  {
    label: "What changed recently?",
    prompt:
      "What changed in the most recent meetings compared with the earlier ones in this project?",
  },
  {
    label: "Risks and blockers",
    prompt: "What risks or blockers have been raised in this project, and were any of them resolved?",
  },
  {
    label: "Catch me up",
    prompt:
      "I have been away. Catch me up on this project in a few paragraphs, most important first.",
  },
];

/** Searches across every meeting, or the ones the user has selected. */
export const WORKSPACE_PROMPTS: ChatPrompt[] = [
  {
    label: "What hasn't been completed?",
    prompt:
      "Across my meetings, what was committed to but does not appear to have been completed?",
  },
  {
    label: "What changed since last week?",
    prompt:
      "What changed since last week's meeting? Compare what was said then with what was said most recently.",
  },
  {
    label: "Compare selected meetings",
    prompt:
      "Compare the meetings I have selected: where do they agree, where do they differ, and what changed between them?",
  },
  {
    label: "Find every mention of…",
    // Left deliberately incomplete: the user finishes it. A concrete example
    // ("Stripe") would be wrong for most workspaces and gets sent as-is by
    // anyone clicking without reading.
    prompt: "Find every discussion about ",
  },
  {
    label: "What did someone say about…",
    prompt: "What did ",
  },
  {
    label: "Conflicting decisions",
    prompt:
      "Do any decisions in my recent meetings conflict with decisions made earlier? Quote both.",
  },
];
