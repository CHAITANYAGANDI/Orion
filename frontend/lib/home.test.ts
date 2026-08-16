import { describe, it, expect } from "vitest";
import { dayKey, dayLabel, groupByDay } from "@/lib/home";
import type { MeetingResponse } from "@/lib/types";

/**
 * Grouping the home list into days.
 *
 * Every failure this guards against renders perfectly and is wrong: a meeting
 * recorded at 23:40 filed under tomorrow because the key was built from UTC; two
 * meetings from the same evening split across "Today" and "Yesterday" because
 * the clock was read twice; "Today" still showing on a tab left open overnight.
 */

function meeting(id: string, createdAt: string): MeetingResponse {
  return {
    id,
    title: id,
    status: "READY",
    tags: [],
    createdAt,
  } as MeetingResponse;
}

/** Local midday, so a test is not itself sensitive to the runner's zone. */
function local(y: number, m: number, d: number, h = 12): string {
  return new Date(y, m - 1, d, h).toISOString();
}

describe("the day a meeting belongs to", () => {
  it("is the local calendar day, not the UTC one", () => {
    // 23:40 local is tomorrow in UTC for anyone east of Greenwich. Filed under
    // tomorrow, the evening's meeting appears above the ones that followed it.
    const late = local(2026, 8, 15, 23);
    expect(dayKey(late)).toBe("2026-08-15");
  });

  it("files an unreadable date under today rather than dropping it", () => {
    const now = new Date(2026, 7, 16, 12);
    expect(dayKey("not-a-date", now)).toBe("2026-08-16");
  });
});

describe("what a day is called", () => {
  const now = new Date(2026, 7, 16, 12);

  it("names today and yesterday, and dates them anyway", () => {
    // "Today" alone is fine on screen and useless the moment it is screenshotted
    // or left open overnight.
    expect(dayLabel("2026-08-16", now)).toMatch(/^Today, /);
    expect(dayLabel("2026-08-15", now)).toMatch(/^Yesterday, /);
  });

  it("uses the weekday inside the past week", () => {
    expect(dayLabel("2026-08-12", now)).toMatch(/^Wed, /);
  });

  it("drops to a bare date once the weekday stops helping", () => {
    const label = dayLabel("2026-06-02", now);
    expect(label).not.toMatch(/Today|Yesterday/);
    expect(label).toContain("Jun");
  });

  it("adds the year once it is no longer obvious", () => {
    expect(dayLabel("2025-03-04", now)).toContain("2025");
  });
});

describe("grouping", () => {
  const now = new Date(2026, 7, 16, 12);

  it("puts each day together, newest day first", () => {
    const groups = groupByDay(
      [
        meeting("a", local(2026, 8, 14)),
        meeting("b", local(2026, 8, 16)),
        meeting("c", local(2026, 8, 16, 9)),
      ],
      now,
    );

    expect(groups.map((g) => g.key)).toEqual(["2026-08-16", "2026-08-14"]);
    expect(groups[0].meetings.map((m) => m.id)).toEqual(["b", "c"]);
  });

  it("keeps each day's own order rather than re-sorting it", () => {
    // The list arrives newest-first from the API. Re-sorting here would make the
    // page disagree with every other list in the product.
    const groups = groupByDay(
      [meeting("later", local(2026, 8, 16, 16)), meeting("earlier", local(2026, 8, 16, 9))],
      now,
    );
    expect(groups[0].meetings.map((m) => m.id)).toEqual(["later", "earlier"]);
  });

  it("reads the clock once, so a list rendered at midnight is consistent", () => {
    // Both meetings are on the 16th. With `now` fixed they land in one group,
    // which is what a caller passing a single `now` is buying.
    const groups = groupByDay(
      [meeting("a", local(2026, 8, 16, 23)), meeting("b", local(2026, 8, 16, 1))],
      now,
    );
    expect(groups).toHaveLength(1);
  });

  it("returns nothing for nothing", () => {
    expect(groupByDay([], now)).toEqual([]);
  });
});
