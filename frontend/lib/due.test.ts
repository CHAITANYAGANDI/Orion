import { describe, it, expect } from "vitest";
import { dueLabel, dueTone, formatDay, isUrgent, parseDay, spokenDeadline } from "@/lib/due";

/**
 * How a deadline reads.
 *
 * <p>Two failures here are silent and both mislead. A date parsed as UTC and
 * rendered locally is off by a day for most of the Americas, which puts "due
 * Thursday" on a task due Friday. And a resolved date shown without the words it
 * came from quietly replaces the promise somebody made with our reading of it.
 */
describe("parsing a day", () => {
  it("reads a plain date as a local day, not a UTC instant", () => {
    // new Date("2026-08-14") is midnight UTC, which is the 13th anywhere west
    // of Greenwich — so this would label a Friday deadline Thursday.
    const day = parseDay("2026-08-14");

    expect(day?.getFullYear()).toBe(2026);
    expect(day?.getMonth()).toBe(7);
    expect(day?.getDate()).toBe(14);
  });

  it("refuses anything that is not a plain date", () => {
    expect(parseDay("friday")).toBeNull();
    expect(parseDay("")).toBeNull();
    expect(parseDay(null)).toBeNull();
  });

  it("names the weekday, which is how deadlines get agreed", () => {
    expect(formatDay("2026-08-14")).toContain("Fri");
    expect(formatDay("2026-08-14")).toContain("14");
  });
});

describe("the deadline label", () => {
  it("says how late rather than making you count", () => {
    expect(dueLabel({ dueOn: "2026-08-12", daysUntilDue: -4 })).toBe("4 days late");
    expect(dueLabel({ dueOn: "2026-08-15", daysUntilDue: -1 })).toBe("1 day late");
  });

  it("says today and tomorrow in words", () => {
    expect(dueLabel({ dueOn: "2026-08-16", daysUntilDue: 0 })).toBe("due today");
    expect(dueLabel({ dueOn: "2026-08-17", daysUntilDue: 1 })).toBe("due tomorrow");
  });

  it("gives a date once it is far enough away to need one", () => {
    expect(dueLabel({ dueOn: "2026-08-21", daysUntilDue: 5 })).toContain("21");
  });

  it("shows the words that were said when there is no date", () => {
    // "before the demo" is a real deadline that no parser can read. Dropping it
    // would lose the only thing anybody agreed to.
    expect(dueLabel({ dueDate: "before the demo", dueOn: null })).toBe("due before the demo");
  });

  it("is empty when there is no deadline at all", () => {
    expect(dueLabel({})).toBe("");
    expect(dueLabel({ dueDate: "   " })).toBe("");
  });

  it("stops counting once the task is finished", () => {
    // "6 days late" on something already ticked off is noise that teaches
    // people to ignore the label.
    expect(dueLabel({ dueOn: "2026-08-10", daysUntilDue: -6, status: "DONE" })).toContain("due");
    expect(dueLabel({ dueOn: "2026-08-10", daysUntilDue: -6, status: "DONE" })).not.toContain("late");
  });
});

describe("keeping the original phrasing", () => {
  it("offers what was said when the label is showing our reading", () => {
    expect(spokenDeadline({ dueDate: "friday", dueOn: "2026-08-14" })).toBe("Said: “friday”");
  });

  it("says nothing when the two are the same", () => {
    // A tooltip repeating the text beside it is furniture.
    expect(spokenDeadline({ dueDate: "2026-08-14", dueOn: "2026-08-14" })).toBeNull();
  });

  it("says nothing when the label is already the original", () => {
    expect(spokenDeadline({ dueDate: "before the demo", dueOn: null })).toBeNull();
  });
});

describe("colour", () => {
  it("colours only what is late or due now", () => {
    expect(dueTone("OVERDUE")).toContain("destructive");
    expect(dueTone("TODAY")).toContain("amber");

    // A tracker where every row is tinted has told you nothing.
    expect(dueTone("SOON")).toBe(dueTone("LATER"));
    expect(dueTone("LATER")).toBe(dueTone("NONE"));
  });

  it("agrees with itself about which states are urgent", () => {
    expect(isUrgent("OVERDUE")).toBe(true);
    expect(isUrgent("TODAY")).toBe(true);
    expect(isUrgent("SOON")).toBe(false);
    expect(isUrgent("NONE")).toBe(false);
  });
});
