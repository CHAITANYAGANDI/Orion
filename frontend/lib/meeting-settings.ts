/**
 * The two dropdowns on Account Settings → Meetings.
 *
 * Both are "a number of days, or none", and both express none as `null` rather
 * than 0 — the server distinguishes "leave it alone" from "clear it" with a
 * separate flag, and a 0 sent as a number would be neither.
 *
 * The choices are short on purpose. A free-number input invites 1 and 3650, and
 * neither is a decision anybody makes deliberately: a link that dies tomorrow is
 * a link that dies before the meeting it was shared about, and a ten-year window
 * is the same as no window with extra confidence.
 */

export interface DayChoice {
  label: string;
  /** Null is the open-ended option — never expires, or reads everything. */
  days: number | null;
}

/**
 * Expiry for new share links.
 *
 * "Never" is first and is the existing behaviour, because every link ever
 * created has it and a default that started expiring them would revoke access
 * nobody asked to revoke.
 */
export const SHARE_EXPIRY_CHOICES: DayChoice[] = [
  { label: "Never", days: null },
  { label: "After 7 days", days: 7 },
  { label: "After 30 days", days: 30 },
  { label: "After 90 days", days: 90 },
  { label: "After a year", days: 365 },
];

/** How far back the workspace chat reads. */
export const CHAT_WINDOW_CHOICES: DayChoice[] = [
  { label: "Every meeting", days: null },
  { label: "Last 12 months", days: 365 },
  { label: "Last 90 days", days: 90 },
  { label: "Last 30 days", days: 30 },
];

/**
 * The label for a stored number of days.
 *
 * A value that is not one of the choices — set through the API, or left over
 * from a choice that has since been removed — is named rather than silently
 * shown as the default, which would be the page claiming a setting the account
 * does not have.
 */
export function dayChoiceLabel(days: number | null, choices: DayChoice[]): string {
  const known = choices.find((c) => c.days === days);
  if (known) return known.label;
  return days === null ? choices[0].label : `${days} days`;
}
