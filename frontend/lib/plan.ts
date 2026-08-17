/**
 * The one plan, and what is actually in it.
 *
 * Recallix has a single tier. That is not a limitation being apologised for —
 * it is why this page can be written honestly, because with nothing to sell
 * there is no reason to describe a feature generously or to leave an absence
 * out. Every line below is something the code does, at the limit the code
 * enforces.
 *
 * Kept as data rather than markup so the claims can be read in one place and
 * checked against the services that back them. Where a number appears it comes
 * from a named constant on the server — 500 terms from
 * `VocabularyService.MAX_TERMS_PER_USER`, 200 folders from
 * `ProjectService.MAX_PROJECTS`, 2,000 marks from `MomentService.MAX_PER_MEETING`
 * — and the monthly meeting count comes from `Plan.FREE`, which is the only one
 * of them a user can actually hit.
 *
 * {@link NOT_INCLUDED} is the half of a plans page that is normally missing.
 * Somebody comparing Recallix to Otter will assume a bot joins their calls,
 * because every competitor has one; finding out after a meeting they expected
 * to be recorded is the worst possible moment.
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
        label: "Speakers separated, and named once you have taught it a voice",
      },
      {
        label: "A summary with decisions, risks and action items",
        detail: "Quotations in it are matched back to the transcript before they are stored.",
      },
      {
        label: "Translation of the brief, the tasks and the transcript",
        detail: "Kept once translated, so reading it again costs nothing.",
      },
      {
        label: "Custom vocabulary",
        detail: "Up to 500 names, acronyms and product words. Applies to meetings processed from then on.",
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
        label: "Five meetings a month",
        detail:
          "Recorded and imported ones together. The sixth is refused until the month turns over; nothing already processed is taken away.",
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
        detail: "Narrowed by speaker, date range, folder, status or tag.",
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
      { label: "Exporting the whole account as a zip, with JSON another system can read" },
      { label: "Share links, with a password and an expiry" },
      { label: "A calendar feed of your deadlines", detail: "Read-only, and one way." },
      { label: "Email recaps and a daily digest of what is due" },
    ],
  },
];

/**
 * What Recallix does not do.
 *
 * Written as flatly as the list above. Each of these is a thing a reader has a
 * live reason to expect, and every one of them is cheaper to learn here than
 * halfway through relying on it.
 */
export const NOT_INCLUDED: Feature[] = [
  {
    label: "No meeting bot",
    detail:
      "Recallix never joins a Zoom, Teams or Meet call and never appears in a participant list. Recording happens in your own browser tab, which is also why nothing can start it for you.",
  },
  {
    label: "Nothing live",
    detail:
      "Transcription starts when a recording stops. There are no captions during the call and no running transcript to watch.",
  },
  {
    label: "No mobile apps",
    detail:
      "The web app is the whole product. Recording works in a phone browser; there is nothing in an app store.",
  },
  {
    label: "One account, not a team",
    detail:
      "There are no seats, no shared workspace and no invitations. Everything you record is yours alone until you publish a link.",
  },
  {
    label: "Nothing to upgrade to",
    detail:
      "There is no paid tier, so nothing above is being withheld from you and no limit here exists to sell you past it.",
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
