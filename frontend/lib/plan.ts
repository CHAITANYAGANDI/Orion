/**
 * The one plan, and what is actually in it.
 *
 * Orion has a single tier. That is not a limitation being apologised for —
 * it is why this page can be written honestly, because with nothing to sell
 * there is no reason to describe a feature generously or to leave an absence
 * out. Every line below is something the code does, at the limit the code
 * enforces.
 *
 * Kept as data rather than markup so the claims can be read in one place and
 * checked against the services that back them. Where a number appears it comes
 * from a named constant on the server — 200 folders from
 * `ProjectService.MAX_PROJECTS`, 2,000 marks from `MomentService.MAX_PER_MEETING`
 * — and the two a user can actually hit are `UsageLimitService.MINUTES_ALLOWANCE`
 * and `IMPORT_ALLOWANCE`.
 */

export interface Feature {
  label: string;
  /** The qualifier that stops the label overpromising. Optional, but usually earned. */
  detail?: string;
}

export interface FeatureGroup {
  heading: string;
  features: Feature[];
}

/** What the plan is called in the UI. The server calls it `FREE`. */
export const PLAN_NAME = "Basic";

export const INCLUDED: FeatureGroup[] = [
  {
    heading: "Transcription",
    features: [
      {
        label: "Automatic transcription in 18 languages",
        detail:
          "Detected from the audio, or fixed to one language under General so a quiet opening cannot mislead it.",
      },
      {
        label: "Speakers separated, and yours to name",
        detail:
          "Diarization tells the voices apart and numbers them by who spoke first. Naming them is a rename you make, not a voice Orion recognises.",
      },
      {
        label: "A summary with decisions, risks and action items",
        detail: "Quotations in it are matched back to the transcript before they are stored.",
      },
      {
        label: "Translation of the brief, the tasks and the transcript",
        detail: "Kept once translated, so reading it again costs nothing.",
      },
      { label: "Summary templates, to choose what a summary is built to say" },
    ],
  },
  {
    heading: "Recording and import",
    features: [
      {
        label: "Recording in your browser",
        detail: "Nothing to install, and nothing joins the call to do it.",
      },
      { label: "Importing an audio or video file you already have" },
      {
        label: "100 minutes of transcription",
        detail:
          "For the life of the account, not per month: there is no date it comes back. Recording and importing both spend it, the length of the recording is what it costs, and nothing already transcribed is taken away once it runs out.",
      },
      {
        label: "Three imported files",
        detail:
          "Counted separately from the minutes, and only files: recording in your own browser is not an import, however many times you do it.",
      },
    ],
  },
  {
    heading: "Playback",
    features: [
      { label: "0.5x to 2x, in seven steps" },
      {
        label: "Skip silence, jump between speakers, play highlights only",
        detail:
          "Driven by the transcript rather than by the waveform, so the jumps land on words instead of on loudness.",
      },
    ],
  },
  {
    heading: "Working with a meeting",
    features: [
      { label: "Editing the transcript text and the speaker labels" },
      { label: "Highlights, notes and bookmarks", detail: "Up to 2,000 on a single meeting." },
      { label: "Action items with owners, due dates and comments" },
      { label: "Folders", detail: "Up to 200." },
      {
        label: "Search across every meeting",
        detail:
          "Titles, tags and every sentence anyone said. Narrowed as you type with tag:, type:, in: a folder and when: a date range, completed from what your workspace actually has.",
      },
      {
        label: "AI Chat, on one meeting or across all of them",
        detail: "No monthly cap on questions.",
      },
    ],
  },
  {
    heading: "Getting things out",
    features: [
      { label: "Exporting a meeting as PDF, Word, Markdown or plain text" },
      {
        label: "Downloading the original recording",
        detail: "The file you recorded or imported, as it was stored.",
      },
    ],
  },
];


/**
 * How a usage figure reads against its ceiling.
 *
 * `-1` is the server's unlimited, and it has to survive the round trip as a
 * distinct state: rendering it as `21 / -1` is the kind of thing that ships,
 * and `21 / 0` would be worse because it looks like a number.
 */
export function usageLabel(used: number, limit: number): string {
  return limit < 0 ? `${used} used` : `${used} of ${limit}`;
}

/** How full the bar is. Unlimited shows a token sliver rather than an empty or full track. */
export function usageFraction(used: number, limit: number): number {
  if (limit < 0) return 4;
  if (limit === 0) return 100;
  return Math.min(100, Math.round((used / limit) * 100));
}

/**
 * The count on its own, for a sentence that supplies its own verb.
 *
 * `usageLabel` reads "21 used", which is a whole clause and cannot be put in
 * front of one — "21 used monthly meetings used". The rail's meter needs the
 * bold half of "**3 of 5** monthly meetings used", so unlimited drops the
 * ceiling rather than the noun.
 */
export function quotaCount(used: number, limit: number): string {
  return limit < 0 ? `${used}` : `${used} of ${limit}`;
}

/**
 * What to call the plan somebody is on.
 *
 * FREE is {@link PLAN_NAME}, because that is the word the product uses. The
 * other two are named as the server names them — an account still carrying PRO
 * or PREMIUM from an earlier build says so rather than claiming to be Basic.
 * The allowance is the same either way now: one pair of numbers for every
 * account, so the name is a label and not a promise about limits.
 */
export function planLabel(plan: string): string {
  if (plan === "FREE") return PLAN_NAME;
  return plan.charAt(0) + plan.slice(1).toLowerCase();
}
