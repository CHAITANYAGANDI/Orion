/**
 * Grouping chat threads by recency for the history picker.
 *
 * Kept out of the component because the boundaries are the whole feature: a
 * list of thirty conversations sorted by timestamp is not history, it is a log.
 * "Today / Past week / Older" is what makes it possible to find the thing you
 * were doing this morning without reading dates.
 *
 * Boundaries are calendar-based, not elapsed-time. Something said at 11pm last
 * night is not "today" at 9am even though it is ten hours ago, and a user
 * looking for it will look under Yesterday.
 */

import type { ChatConversation } from "@/lib/types";

export type BucketName = "Today" | "Yesterday" | "Past week" | "Past month" | "Older";

/** Order they are rendered in — most recent first. */
export const BUCKET_ORDER: BucketName[] = [
  "Today",
  "Yesterday",
  "Past week",
  "Past month",
  "Older",
];

export interface Bucket {
  name: BucketName;
  conversations: ChatConversation[];
}

/** Midnight at the start of the day `date` falls in, in the viewer's zone. */
function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysBefore(reference: Date, days: number): Date {
  const d = startOfDay(reference);
  d.setDate(d.getDate() - days);
  return d;
}

export function bucketFor(updatedAt: string, now: Date = new Date()): BucketName {
  const at = new Date(updatedAt);
  // An unparseable timestamp must not throw and must not claim to be recent:
  // sorting it to the bottom is the honest failure.
  if (Number.isNaN(at.getTime())) return "Older";

  // A clock skewed slightly ahead of the server would otherwise put a thread
  // that was just written into the future, where no bucket claims it.
  if (at >= startOfDay(now)) return "Today";
  if (at >= daysBefore(now, 1)) return "Yesterday";
  if (at >= daysBefore(now, 7)) return "Past week";
  if (at >= daysBefore(now, 30)) return "Past month";
  return "Older";
}

/**
 * Bucket the threads, dropping empty groups.
 *
 * Input is expected newest-first (as the API returns it) and that order is
 * preserved inside each group, so the picker never has to re-sort.
 */
export function groupConversations(
  conversations: ChatConversation[],
  now: Date = new Date(),
): Bucket[] {
  const byName = new Map<BucketName, ChatConversation[]>();
  for (const c of conversations) {
    const name = bucketFor(c.updatedAt, now);
    const list = byName.get(name);
    if (list) list.push(c);
    else byName.set(name, [c]);
  }
  return BUCKET_ORDER.filter((name) => byName.has(name)).map((name) => ({
    name,
    conversations: byName.get(name)!,
  }));
}

/**
 * "2m ago", "4d ago" — the subtitle on each row.
 *
 * Coarse on purpose. The bucket heading already says roughly when; this only
 * has to separate two threads inside the same group, and "3 minutes ago" in a
 * narrow menu wraps.
 */
export function relativeTime(updatedAt: string, now: Date = new Date()): string {
  const at = new Date(updatedAt);
  if (Number.isNaN(at.getTime())) return "";

  const seconds = Math.round((now.getTime() - at.getTime()) / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;

  return `${Math.round(months / 12)}y ago`;
}
