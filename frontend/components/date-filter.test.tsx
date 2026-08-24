import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  DateFilter,
  ANY_TIME,
  dayWindow,
  sinceWindow,
  restoreWindow,
  type DateWindow,
} from "@/components/date-filter";

/**
 * Filtering the archive by date.
 *
 * <p>Everything worth protecting here is about boundaries, and every failure is
 * quiet. A window that is inclusive at both ends puts a meeting recorded at
 * midnight under two days. A "last 7 days" measured from *now* rather than from
 * midnight drops its oldest meeting partway through the afternoon, which reads
 * as an archive that lost something. And a bound built in UTC rather than in
 * the reader's own timezone shows the wrong day to everybody who is not in
 * London — worst in the timezones where "today" has not started yet in UTC.
 *
 * <p>Local midnight is asserted as local midnight (`getHours() === 0`) rather
 * than against a fixed ISO string, because a hard-coded `Z` string would only
 * be true on a machine set to UTC, and would pass there while shipping the bug.
 */

// A Thursday, mid-afternoon, so "today" and "now" are visibly different.
const NOW = new Date(2026, 7, 13, 15, 42, 0);

beforeEach(() => {
  // `shouldAdvanceTime` is load-bearing: user-event waits on real timers between
  // synthetic events, and a frozen clock leaves every interaction hanging until
  // the test times out.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function filter(value: DateWindow = ANY_TIME) {
  const onChange = vi.fn();
  render(<DateFilter value={value} onChange={onChange} />);
  return { onChange };
}

/** userEvent drives its own clock, so it has to be told about the fake one. */
function ui() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

async function open(user: ReturnType<typeof ui>) {
  await user.click(screen.getByRole("button", { expanded: false }));
  return screen.getByRole("dialog", { name: "Filter by date" });
}

describe("window arithmetic", () => {
  it("makes one day a half-open midnight-to-midnight span", () => {
    const w = dayWindow(new Date(2026, 7, 13, 9, 0), NOW);
    const from = new Date(w.from!);
    const to = new Date(w.to!);

    expect(from.getHours()).toBe(0);
    expect(from.getDate()).toBe(13);
    expect(to.getHours()).toBe(0);
    // Exclusive: a meeting recorded on the stroke of the 14th belongs to the
    // 14th, not to both days.
    expect(to.getDate()).toBe(14);
  });

  it("calls the current day Today rather than its date", () => {
    expect(dayWindow(NOW, NOW).label).toBe("Today");
    expect(dayWindow(new Date(2026, 7, 11), NOW).label).toContain("11");
  });

  it("names the year only when it is not this one", () => {
    expect(dayWindow(new Date(2026, 0, 3), NOW).label).not.toContain("2026");
    expect(dayWindow(new Date(2024, 0, 3), NOW).label).toContain("2024");
  });

  it("rolls a period from midnight, not from this moment", () => {
    const w = sinceWindow(7, "Last 7 days", NOW);
    const from = new Date(w.from!);

    // From midnight seven days ago. Measured from 15:42, the oldest meeting in
    // the window would drop out of it at 15:43 for no visible reason.
    expect(from.getHours()).toBe(0);
    expect(from.getDate()).toBe(6);
    // No upper bound: "the last 7 days" includes anything recorded since.
    expect(w.to).toBeNull();
  });
});

describe("DateFilter", () => {
  it("shows the window it is filtering by", () => {
    filter({ from: null, to: null, label: "Any time" });
    expect(screen.getByRole("button", { name: /Any time/ })).toBeInTheDocument();
  });

  it("offers the periods people actually ask for", async () => {
    const user = ui();
    filter();
    const panel = await open(user);

    for (const label of ["Any time", "Today", "Last 7 days", "Last 30 days"]) {
      expect(within(panel).getByRole("button", { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it("shows the date a preset resolves to, so it can be checked", async () => {
    const user = ui();
    filter();
    const panel = await open(user);

    // "Last 7 days" is a claim; the date beside it is what makes it checkable.
    const preset = within(panel).getByRole("button", { name: /Last 7 days/ });
    expect(preset.textContent).toMatch(/Aug/);
  });

  it("filters to a single day when one is picked", async () => {
    const user = ui();
    const { onChange } = filter();
    const panel = await open(user);

    await user.click(within(panel).getByRole("button", { name: "11" }));

    const w = onChange.mock.calls[0][0] as DateWindow;
    expect(new Date(w.from!).getDate()).toBe(11);
    expect(new Date(w.to!).getDate()).toBe(12);
  });

  it("will not offer a day nothing could have been recorded on", async () => {
    const user = ui();
    filter();
    const panel = await open(user);

    expect(within(panel).getByRole("button", { name: "13" })).not.toBeDisabled();
    // Tomorrow, and the rest of the month, are guaranteed empty.
    expect(within(panel).getByRole("button", { name: "14" })).toBeDisabled();
    expect(within(panel).getByRole("button", { name: "Next month" })).toBeDisabled();
  });

  it("goes back through the months and lets you return", async () => {
    const user = ui();
    filter();
    const panel = await open(user);

    await user.click(within(panel).getByRole("button", { name: "Previous month" }));
    expect(within(panel).getByText(/July 2026/)).toBeInTheDocument();
    // July is over, so every day of it is selectable.
    expect(within(panel).getByRole("button", { name: "31" })).not.toBeDisabled();
    expect(within(panel).getByRole("button", { name: "Next month" })).not.toBeDisabled();
  });

  it("clears back to everything", async () => {
    const user = ui();
    const { onChange } = filter(dayWindow(new Date(2026, 7, 11), NOW));
    const panel = await open(user);

    await user.click(within(panel).getByRole("button", { name: /Any time/ }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ from: null, to: null }));
  });

  it("marks the day it is currently filtering by", async () => {
    const user = ui();
    filter(dayWindow(new Date(2026, 7, 11), NOW));
    const panel = await open(user);

    expect(within(panel).getByRole("button", { name: "11" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(panel).getByRole("button", { name: "12" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("does not mark a day when the window is a period", async () => {
    const user = ui();
    filter(sinceWindow(7, "Last 7 days", NOW));
    const panel = await open(user);

    // A seven-day window is not "the 6th", and highlighting the 6th would say
    // it was.
    expect(within(panel).getByRole("button", { name: "6" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("closes on Escape without changing anything", async () => {
    const user = ui();
    const { onChange } = filter();
    await open(user);

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});

/**
 * What survives a page, and how.
 *
 * <p>The window is two absolute instants, and instants are exactly the wrong
 * thing to write down. "Last 7 days" stored as instants stops rolling; "Today"
 * stored as instants is labelled Today over yesterday's list. So what is stored
 * is the choice, and what is tested here is that the choice comes back as the
 * window it originally meant — against the clock of whenever it is read, not
 * the clock it was made on.
 */
describe("remembering a choice", () => {
  /** A week later, so anything frozen to the moment of choosing shows up. */
  const LATER = new Date(2026, 7, 20, 9, 15, 0);

  it("hands the choice back with the window when a preset is picked", async () => {
    const user = ui();
    const { onChange } = filter();
    const panel = await open(user);

    await user.click(within(panel).getByRole("button", { name: /Last 7 days/ }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ choice: { kind: "preset", key: "week" } }),
    );
  });

  it("hands back the day as a local date when one is picked", async () => {
    const user = ui();
    const { onChange } = filter();
    const panel = await open(user);

    await user.click(within(panel).getByRole("button", { name: "11" }));

    // The local calendar date, not `toISOString()` -- which is the previous day
    // for anybody west of Greenwich.
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ choice: { kind: "day", day: "2026-08-11" } }),
    );
  });

  it("rolls a period forward to the day it is read on", () => {
    const stored = sinceWindow(7, "Last 7 days", NOW).from;
    const restored = restoreWindow({ kind: "preset", key: "week" }, LATER);

    // A week later it means a different week. Storing the instants would have
    // left it pinned to the 6th for ever.
    expect(restored?.label).toBe("Last 7 days");
    expect(restored?.from).not.toBe(stored);
    expect(new Date(restored!.from!).getDate()).toBe(13);
  });

  it("rebuilds Today as today, not as the day it was chosen", () => {
    const restored = restoreWindow({ kind: "preset", key: "today" }, LATER);

    expect(restored?.label).toBe("Today");
    const from = new Date(restored!.from!);
    expect(from.getDate()).toBe(20);
    expect(from.getHours()).toBe(0);
  });

  it("brings back a single day exactly as it was", () => {
    const restored = restoreWindow({ kind: "day", day: "2026-08-11" }, LATER);

    // The one case where the instants *are* the choice: the 11th is the 11th
    // whenever it is read.
    const from = new Date(restored!.from!);
    expect(from.getFullYear()).toBe(2026);
    expect(from.getMonth()).toBe(7);
    expect(from.getDate()).toBe(11);
    expect(from.getHours()).toBe(0);
    expect(restored?.choice).toEqual({ kind: "day", day: "2026-08-11" });
  });

  it("reads a stored day in the reader's timezone, not in UTC", () => {
    const restored = restoreWindow({ kind: "day", day: "2026-08-11" }, LATER);

    // `new Date("2026-08-11")` is midnight UTC, which is the 10th in the
    // Americas. Every window this filter builds is local midnight, and this one
    // has to match or the stored day quietly shifts by one.
    expect(new Date(restored!.from!).getHours()).toBe(0);
    expect(restored!.to).toBe(
      new Date(2026, 7, 12).toISOString(),
    );
  });

  it("survives a round trip through the picker", async () => {
    const user = ui();
    const { onChange } = filter();
    const panel = await open(user);
    await user.click(within(panel).getByRole("button", { name: /Last 30 days/ }));

    const chosen = onChange.mock.calls[0][0] as DateWindow;
    const restored = restoreWindow(chosen.choice, NOW);

    expect(restored).toEqual(chosen);
  });

  it("declines anything it cannot make sense of", () => {
    // Each of these becomes the default rather than a filter nobody can
    // explain: a list narrowed for an invisible reason is worse than a wide one.
    expect(restoreWindow(null)).toBeNull();
    expect(restoreWindow("week")).toBeNull();
    expect(restoreWindow({})).toBeNull();
    expect(restoreWindow({ kind: "preset" })).toBeNull();
    // A key from a build that offered a preset this one does not.
    expect(restoreWindow({ kind: "preset", key: "quarter" })).toBeNull();
    expect(restoreWindow({ kind: "day" })).toBeNull();
    expect(restoreWindow({ kind: "day", day: "11/08/2026" })).toBeNull();
    expect(restoreWindow({ kind: "day", day: "2026-13-45" })).toBeNull();
  });

  it("declines a day in the future", () => {
    // The calendar will not let one be picked, so one in storage means a clock
    // that moved -- and a filter guaranteed to be empty.
    expect(restoreWindow({ kind: "day", day: "2026-09-01" }, NOW)).toBeNull();
    expect(restoreWindow({ kind: "day", day: "2026-08-13" }, NOW)).not.toBeNull();
  });

  it("carries its own choice on Any time", () => {
    // Home clears the date filter with ANY_TIME directly rather than through
    // the picker, and that is still a choice worth remembering.
    expect(ANY_TIME.choice).toEqual({ kind: "preset", key: "any" });
    expect(restoreWindow(ANY_TIME.choice, NOW)).toEqual(ANY_TIME);
  });
});
