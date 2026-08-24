"use client";

/**
 * Narrowing a list of meetings to a stretch of time.
 *
 * <p>A month grid and three presets, because the two questions people bring to
 * an archive are different shapes. "What have I got from the last week" is a
 * period and wants a preset; "what was that thing on the 13th" is a point and
 * wants a calendar. A control offering only one of them makes the other into
 * scrolling.
 *
 * <p>The window it produces is half-open — `from` inclusive, `to` exclusive —
 * so picking a day is midnight to midnight and a meeting recorded on the stroke
 * of one cannot appear under two different days. Both ends are absolute
 * instants computed here rather than a preset name sent to the server, because
 * only the browser knows which midnight the user meant: "today" in Auckland is
 * a different pair of instants from "today" in Lisbon.
 *
 * <p>Days in the future are not selectable and the month cannot be paged past
 * this one. Nothing was recorded tomorrow, so offering it is offering a
 * guaranteed empty result.
 */

import * as React from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** The presets under the calendar, as stable ids. */
export type PresetKey = "any" | "today" | "week" | "month";

/**
 * What was *chosen*, as opposed to what it resolved to.
 *
 * <p>The window itself is two absolute instants, which is right for asking the
 * server and wrong for remembering. "Today" picked yesterday evening is a pair
 * of instants that mean yesterday, and restoring them tomorrow would show a
 * day-old list under a label reading Today. "Last 7 days" would quietly stop
 * rolling. A single day off the calendar is the one case where the instants
 * *are* the choice, and it is stored as a plain local date for the same reason:
 * `2026-08-13` survives a change of timezone as the day somebody clicked.
 *
 * <p>So this is what gets written down, and `restoreWindow` turns it back into
 * a window against the clock of whenever it is read.
 */
export type DateChoice =
  | { kind: "preset"; key: PresetKey }
  /** A local calendar date, `YYYY-MM-DD`. */
  | { kind: "day"; day: string };

/** The window a filter is asking for, plus what to call it on the trigger. */
export interface DateWindow {
  /** Inclusive ISO instant, or null for no lower bound. */
  from: string | null;
  /** Exclusive ISO instant, or null for no upper bound. */
  to: string | null;
  label: string;
  /**
   * How this window was arrived at, when it came from the picker.
   *
   * <p>Optional because a window can be built directly — `dayWindow` and
   * `sinceWindow` are exported and used on their own — and a window with no
   * choice attached is simply one that cannot be restored later, which falls
   * back to the default rather than guessing.
   */
  choice?: DateChoice;
}

export const ANY_TIME: DateWindow = {
  from: null,
  to: null,
  label: "Any time",
  choice: { kind: "preset", key: "any" },
};

function midnight(d: Date): Date {
  const out = new Date(d.getTime());
  out.setHours(0, 0, 0, 0);
  return out;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + days);
  return out;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** One whole day, in the reader's own timezone. */
export function dayWindow(day: Date, now: Date = new Date()): DateWindow {
  const start = midnight(day);
  return {
    from: start.toISOString(),
    to: addDays(start, 1).toISOString(),
    label: sameDay(start, now)
      ? "Today"
      : start.toLocaleDateString(undefined, {
          weekday: "short",
          day: "numeric",
          month: "short",
          // Only when it is not this year — "13 Aug 2024" is worth saying, and
          // "13 Aug 2026" on every row of a current archive is not.
          ...(start.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
        }),
  };
}

/**
 * Everything since a point, with no upper bound.
 *
 * Rolling from midnight rather than from this moment: a meeting at nine this
 * morning is inside "the last 7 days" all day, and an hours-based window would
 * drop the oldest one partway through the afternoon for no reason the reader
 * could see.
 */
export function sinceWindow(days: number, label: string, now: Date = new Date()): DateWindow {
  return { from: midnight(addDays(now, -days)).toISOString(), to: null, label };
}

const PRESETS: { key: PresetKey; label: string; make: (now: Date) => DateWindow }[] = [
  { key: "any", label: "Any time", make: () => ANY_TIME },
  { key: "today", label: "Today", make: (now) => dayWindow(now, now) },
  { key: "week", label: "Last 7 days", make: (now) => sinceWindow(7, "Last 7 days", now) },
  { key: "month", label: "Last 30 days", make: (now) => sinceWindow(30, "Last 30 days", now) },
];

/** A local calendar date as `YYYY-MM-DD`, which is not what `toISOString` gives. */
export function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Turn a remembered choice back into a window, against the clock right now.
 *
 * <p>Returns null for anything it does not recognise — a key from a build that
 * offered a preset this one does not, a malformed date, a day in the future
 * that the calendar would not have allowed. The caller falls back to its
 * default, because a filter restored from something unreadable is worse than no
 * filter: it narrows a list for a reason nobody can see.
 */
export function restoreWindow(raw: unknown, now: Date = new Date()): DateWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const choice = raw as Partial<DateChoice>;

  if (choice.kind === "preset") {
    const preset = PRESETS.find((p) => p.key === (choice as { key: string }).key);
    if (!preset) return null;
    // Rebuilt from `now`, which is the entire point: a rolling window has to
    // roll, and Today has to mean today.
    return { ...preset.make(now), choice: { kind: "preset", key: preset.key } };
  }

  if (choice.kind === "day") {
    const day = (choice as { day: unknown }).day;
    if (typeof day !== "string") return null;
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    if (!parts) return null;
    // Constructed field by field, not parsed: `new Date("2026-08-13")` is
    // midnight UTC, which is the previous day for anybody west of Greenwich.
    const local = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
    if (Number.isNaN(local.getTime())) return null;
    if (local.getTime() > midnight(now).getTime()) return null;
    return { ...dayWindow(local, now), choice: { kind: "day", day } };
  }

  return null;
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

/** The Sundays-first grid for a month, padded to whole weeks. */
function monthGrid(month: Date): (Date | null)[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: (Date | null)[] = Array.from({ length: first.getDay() }, () => null);
  for (let i = 1; i <= days; i++) {
    cells.push(new Date(month.getFullYear(), month.getMonth(), i));
  }
  return cells;
}

export function DateFilter({
  value,
  onChange,
  className,
}: {
  value: DateWindow;
  onChange: (next: DateWindow) => void;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [now] = React.useState(() => new Date());
  const [month, setMonth] = React.useState(() => new Date(now.getFullYear(), now.getMonth(), 1));
  const root = React.useRef<HTMLDivElement | null>(null);

  // Dismissal. Pointerdown rather than click, so the panel closes on the press
  // that starts a drag somewhere else rather than lingering until the release.
  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const cells = React.useMemo(() => monthGrid(month), [month]);
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const atLatestMonth = month.getTime() >= thisMonth.getTime();

  /** The day currently filtering, if the window happens to be exactly one day. */
  const selectedDay = React.useMemo(() => {
    if (!value.from || !value.to) return null;
    const from = new Date(value.from);
    const to = new Date(value.to);
    return Math.round((to.getTime() - from.getTime()) / 86_400_000) === 1 ? from : null;
  }, [value]);

  function pick(next: DateWindow) {
    onChange(next);
    setOpen(false);
  }

  /**
   * Arrow keys walk the grid.
   *
   * Without this a month is thirty-one tab stops between the calendar and the
   * presets under it, which makes the keyboard path to "Last 7 days" longer
   * than reading the list would have been.
   */
  function onGridKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (!step) return;
    e.preventDefault();
    const buttons = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-day]"),
    );
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const next = buttons[at + step];
    if (next && !next.disabled) next.focus();
  }

  return (
    <div ref={root} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium transition-colors hover:bg-accent"
      >
        <CalendarDays className="h-4 w-4 text-muted-foreground" />
        {value.label}
        <ChevronDown
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Filter by date"
          className="absolute left-0 z-40 mt-1 w-[17rem] rounded-lg border bg-popover p-3 shadow-md"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold">
              {month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
            </span>
            <span className="flex items-center gap-0.5">
              <button
                type="button"
                aria-label="Previous month"
                onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="Next month"
                // Nothing was recorded next month.
                disabled={atLatestMonth}
                onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </span>
          </div>

          <div className="mb-1 grid grid-cols-7 text-center text-[11px] text-muted-foreground">
            {WEEKDAYS.map((d, i) => (
              <span key={i}>{d}</span>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-0.5" onKeyDown={onGridKeyDown}>
            {cells.map((day, i) =>
              day === null ? (
                <span key={i} />
              ) : (
                <button
                  key={i}
                  type="button"
                  data-day=""
                  disabled={day.getTime() > midnight(now).getTime()}
                  // The choice rides along with the window so the picker's
                  // owner can remember it. See DateChoice.
                  onClick={() =>
                    pick({ ...dayWindow(day, now), choice: { kind: "day", day: localDay(day) } })
                  }
                  aria-pressed={Boolean(selectedDay && sameDay(day, selectedDay))}
                  className={cn(
                    "flex h-8 items-center justify-center rounded-md text-sm transition-colors",
                    "hover:bg-accent disabled:pointer-events-none disabled:opacity-30",
                    sameDay(day, now) && "font-semibold text-highlight",
                    selectedDay &&
                      sameDay(day, selectedDay) &&
                      "bg-primary text-primary-foreground hover:bg-primary",
                  )}
                >
                  {day.getDate()}
                </button>
              ),
            )}
          </div>

          <p className="mt-2 text-[11px] text-muted-foreground">
            Pick a day to see only that day.
          </p>

          <div className="mt-2 space-y-0.5 border-t pt-2">
            {PRESETS.map((p) => {
              const made = p.make(now);
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => pick({ ...made, choice: { kind: "preset", key: p.key } })}
                  aria-pressed={value.label === made.label}
                  className={cn(
                    "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                    value.label === made.label && "bg-accent",
                  )}
                >
                  {p.label}
                  {/* The date the preset resolves to, so "Last 7 days" is a
                      claim the reader can check rather than take on trust. */}
                  {made.from && (
                    <span className="text-xs text-muted-foreground">
                      {new Date(made.from).toLocaleDateString(undefined, {
                        weekday: "short",
                        day: "numeric",
                        month: "short",
                      })}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
