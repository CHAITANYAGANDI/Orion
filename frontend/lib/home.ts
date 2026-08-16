/**
 * Grouping the home list by day.
 *
 * A meeting archive is read as a diary — "what happened today", "what was that
 * thing on Tuesday" — so the date is a heading rather than a column of
 * timestamps to scan. Pure and separate from the page because the boundaries are
 * calendar days in the reader's own zone, and every part of that is easy to get
 * subtly wrong in a way that renders perfectly: a meeting at 23:40 filed under
 * tomorrow, "Yesterday" still showing at noon the day after, an archive whose
 * groups shuffle between renders because `new Date()` was called in one.
 */

import type { MeetingResponse } from "@/lib/types";

export interface DayGroup {
  /** Stable across renders — the local calendar day, not a formatted label. */
  key: string;
  label: string;
  meetings: MeetingResponse[];
}

/** Local calendar day as `YYYY-MM-DD`, which is what "the same day" means here. */
export function dayKey(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    // An unparseable date is still a meeting. Filed under today rather than
    // dropped, because a row missing from the list is worse than one misdated.
    return dayKey(now.toISOString(), now);
  }
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * "Today, Aug 15" / "Yesterday, Aug 14" / "Sat, Aug 9".
 *
 * The date is in all three, including the relative ones. "Today" alone is fine
 * on screen and useless the moment somebody screenshots it or comes back to a
 * tab left open overnight.
 */
export function dayLabel(key: string, now: Date = new Date()): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const date00 = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const now00 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((now00.getTime() - date00.getTime()) / 86_400_000);

  const stamp = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (days === 0) return `Today, ${stamp}`;
  if (days === 1) return `Yesterday, ${stamp}`;
  if (days > 1 && days < 7) {
    return `${date.toLocaleDateString(undefined, { weekday: "short" })}, ${stamp}`;
  }
  // Older than a week, or in the future — a clock skew, or an imported file
  // dated by its source. The year appears once it stops being obvious.
  return date.getFullYear() === now.getFullYear()
    ? stamp
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Group a list into days, newest first, keeping each day's own order.
 *
 * `now` is taken once by the caller rather than read per row, so a list rendered
 * across midnight is internally consistent — the alternative is two meetings
 * from the same evening landing in "Today" and "Yesterday".
 */
export function groupByDay(
  meetings: MeetingResponse[],
  now: Date = new Date(),
): DayGroup[] {
  const groups = new Map<string, MeetingResponse[]>();
  for (const meeting of meetings) {
    const key = dayKey(meeting.createdAt, now);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(meeting);
    } else {
      groups.set(key, [meeting]);
    }
  }

  return Array.from(groups.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, list]) => ({ key, label: dayLabel(key, now), meetings: list }));
}
