/**
 * The words and numbers the privacy controls are made of.
 *
 * Out here rather than in the pages that render them for two reasons. Next.js
 * refuses to let a route file export anything but a component, so a page cannot
 * be both the screen and the source of a constant. And these are the parts worth
 * testing on their own: the phrase that has to match the server's, the windows
 * that make up a retention promise, and the sentence somebody reads out before
 * pressing record.
 */

/**
 * The retention windows on offer.
 *
 * Deliberately coarse, and deliberately not a free-text field. A retention
 * policy is a promise made to other people about their voices, and "37 days" is
 * not a promise anybody can hold you to — it is a number somebody typed. Every
 * option here is one a person could say out loud in a meeting.
 *
 * Three, where there were six. 90 days, 6 months and a year are all long enough
 * that nobody who picked one would notice the difference between them and
 * keeping everything — the decision they actually encode is "eventually", which
 * is not a promise either. Never, a week and a month are three genuinely
 * different answers, and a shorter list is a list somebody reads.
 *
 * The server still accepts anything from 1 to 3650 days. These are the windows
 * the interface offers, not the windows the API allows, and a policy set to 90
 * by an older client keeps working — {@link retentionLabel} names it rather than
 * pretending it is one of these.
 */
export const RETENTION_CHOICES: { days: number | null; label: string }[] = [
  { days: null, label: "Never" },
  { days: 7, label: "After a week" },
  { days: 30, label: "After a month" },
];

/**
 * What a stored window is called.
 *
 * A value that is not on the list — set through the API, or left from a choice
 * that has since been removed — is named rather than silently drawn as one of
 * the three, which would be the page claiming a policy the account does not
 * have.
 */
export function retentionLabel(days: number | null): string {
  const known = RETENTION_CHOICES.find((c) => c.days === days);
  if (known) return known.label;
  return `After ${days} days`;
}

/**
 * What has to be typed to close an account.
 *
 * Checked here so the button can be disabled, and again by the server so a
 * client that skipped the check cannot delete an account by sending an empty
 * body. The point is that it cannot be produced by a stray click, not that it
 * is hard to type.
 */
export const DELETE_PHRASE = "delete everything";

/** True when the typed confirmation is the phrase, however it was spaced or cased. */
export function confirmsDeletion(typed: string): boolean {
  return typed.trim().toLowerCase() === DELETE_PHRASE;
}

/**
 * The sentence to say before recording.
 *
 * Orion has no bot to announce itself in a participant list — recording
 * happens in the account holder's own browser — so the announcement has to come
 * from them. Handing them the words is the difference between a policy and a
 * thing that actually gets said.
 */
export const RECORDING_ANNOUNCEMENT =
  "Just so everyone knows — I'm recording this meeting with Orion, " +
  "which will transcribe it and write up the notes and action items. " +
  "Say if you'd rather I didn't.";

/** The API's JSON `message` when there is one, so a refusal explains itself. */
export function privacyError(err: unknown): string {
  if (typeof err === "object" && err && "data" in err) {
    const data = (err as { data?: { message?: string } }).data;
    if (data?.message) return data.message;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong";
}
