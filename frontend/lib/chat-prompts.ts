/**
 * Starter prompts for the two grounded chats.
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
    label: "Draft a follow-up email",
    prompt:
      "Draft a follow-up email summarizing this meeting and its action items, ready to send to the participants.",
  },
  {
    label: "Agenda for next time",
    prompt:
      "Based on what was left open in this meeting, draft an agenda for the next one.",
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
