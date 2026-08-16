import type { ActionItemResponse, DueStatus } from "@/lib/types";

/**
 * How a deadline is written on screen.
 *
 * The server decides *whether* something is overdue — see `DueStatus`, which the
 * reminder email uses too. This file only decides how to say it, and the one
 * judgement it makes is which of the two deadlines to show.
 *
 * An action item carries both the words that were said ("Tuesday", "end of
 * day") and our reading of them as a date. The date is the more useful of the
 * two once we have it: "due Fri, 14 Aug" answers the question, "Tuesday" makes
 * you work out which Tuesday. So the resolved date wins where there is one, the
 * original phrasing shows verbatim where there is not, and the phrasing stays
 * available as a tooltip either way — because the promise somebody actually made
 * is a fact about the meeting and should not be paraphrased out of existence.
 */

/**
 * Parse a plain `YYYY-MM-DD` as a local day.
 *
 * `new Date("2026-08-14")` is midnight *UTC*, which renders as the 13th for
 * anybody west of Greenwich — so a task due Friday would be labelled Thursday
 * for most of the Americas.
 */
export function parseDay(iso?: string | null): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Fri, 14 Aug" — the weekday earns its place, since deadlines are agreed in weekdays. */
export function formatDay(iso?: string | null): string {
  const date = parseDay(iso);
  if (!date) return iso ?? "";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/**
 * The deadline as one phrase.
 *
 * Returns an empty string when there is no deadline at all, so callers can test
 * it directly rather than rendering "due —" against tasks nobody dated.
 */
export function dueLabel(item: {
  dueDate?: string | null;
  dueOn?: string | null;
  daysUntilDue?: number | null;
  status?: string;
}): string {
  if (!item.dueOn) {
    // No date we could read. Show what was said, unstyled and unjudged.
    return item.dueDate?.trim() ? `due ${item.dueDate.trim()}` : "";
  }

  const days = item.daysUntilDue;
  if (item.status === "DONE" || days == null) {
    return `due ${formatDay(item.dueOn)}`;
  }
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  if (days === -1) return "1 day late";
  if (days < 0) return `${-days} days late`;
  return `due ${formatDay(item.dueOn)}`;
}

/** The words that were actually said, when the label is showing our reading instead. */
export function spokenDeadline(item: {
  dueDate?: string | null;
  dueOn?: string | null;
}): string | null {
  if (!item.dueOn || !item.dueDate?.trim()) return null;
  const said = item.dueDate.trim();
  return said === item.dueOn ? null : `Said: “${said}”`;
}

/**
 * Colour for a deadline.
 *
 * Only lateness and today get a colour. Everything else is ordinary text — a
 * tracker where every row is tinted has told you nothing, and the two states
 * worth interrupting somebody for stop standing out.
 */
export function dueTone(status: DueStatus): string {
  switch (status) {
    case "OVERDUE":
      return "text-destructive font-medium";
    case "TODAY":
      return "text-amber-600 dark:text-amber-400 font-medium";
    default:
      return "text-muted-foreground";
  }
}

/** Whether this deadline is worth a badge of its own rather than a line of text. */
export function isUrgent(status: DueStatus): boolean {
  return status === "OVERDUE" || status === "TODAY";
}

export function dueBadgeLabel(item: ActionItemResponse): string {
  if (item.dueStatus === "TODAY") return "Due today";
  const days = item.daysUntilDue ?? 0;
  return days === -1 ? "1 day overdue" : `${-days} days overdue`;
}
