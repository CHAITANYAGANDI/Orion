import { describe, it, expect } from "vitest";
import {
  formatDate,
  formatDateTime,
  formatDuration,
  timecode,
  statusProgress,
  statusLabel,
  isTerminal,
} from "@/lib/format";

/**
 * Formatting a meeting's numbers.
 *
 * These run on every row of every list, so the cases that matter are the empty
 * ones: a meeting that is still processing has no duration, and a document has
 * no timeline at all. Rendering "0m 0s" or "NaN" for those is the failure —
 * both look like a real measurement of zero rather than an absent one.
 *
 * Locale-dependent output is asserted loosely on purpose. Pinning the exact
 * string would test the CI machine's locale, and would start failing on a
 * developer's laptop for reasons that have nothing to do with the code.
 */
describe("formatDuration", () => {
  it("renders minutes and seconds under an hour", () => {
    expect(formatDuration(125)).toBe("2m 5s");
  });

  it("switches to hours and minutes at the hour", () => {
    expect(formatDuration(3600)).toBe("1h 0m");
    expect(formatDuration(3725)).toBe("1h 2m");
  });

  it("renders a dash rather than a zero when there is no duration", () => {
    // A meeting still transcribing has none, and a PDF never will. "0m 0s"
    // would read as a measured zero-length recording.
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(0)).toBe("—");
  });

  it("does not round a sub-minute recording away", () => {
    expect(formatDuration(42)).toBe("0m 42s");
  });
});

describe("timecode", () => {
  it("zero-pads both halves so the column stays aligned", () => {
    expect(timecode(0)).toBe("00:00");
    expect(timecode(9)).toBe("00:09");
    expect(timecode(61)).toBe("01:01");
  });

  it("truncates rather than rounds", () => {
    // Rounding up would produce a timecode a second past the moment, and
    // clicking it would start playback after the word it points at.
    expect(timecode(59.9)).toBe("00:59");
  });

  it("keeps counting past an hour rather than wrapping", () => {
    // mm:ss with no hour field: 90 minutes has to read as 90, not as 30.
    expect(timecode(5400)).toBe("90:00");
  });
});

describe("formatDate / formatDateTime", () => {
  it("renders a dash for a missing date", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
  });

  it("echoes an unparseable value instead of printing 'Invalid Date'", () => {
    expect(formatDate("not a date")).toBe("not a date");
    expect(formatDateTime("not a date")).toBe("not a date");
  });

  it("formats a real timestamp into something human", () => {
    const out = formatDate("2026-08-13T14:30:00Z");
    expect(out).not.toBe("—");
    expect(out).toContain("2026");
  });
});

describe("status helpers", () => {
  it("advances monotonically through the pipeline", () => {
    // A progress bar that goes backwards reads as a failure and a retry.
    const stages = [
      "CREATED",
      "UPLOADED",
      "QUEUED",
      "TRANSCRIBING",
      "SUMMARIZING",
      "EXTRACTING",
      "READY",
    ] as const;
    const values = stages.map(statusProgress);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(values[values.length - 1]).toBe(100);
  });

  it("shows a failure as finished, not as stuck at 85 percent", () => {
    expect(statusProgress("FAILED")).toBe(100);
  });

  it("treats only READY and FAILED as terminal", () => {
    expect(isTerminal("READY")).toBe(true);
    expect(isTerminal("FAILED")).toBe(true);
    expect(isTerminal("TRANSCRIBING")).toBe(false);
    expect(isTerminal("QUEUED")).toBe(false);
  });

  it("labels every status it can be given", () => {
    const stages = [
      "CREATED",
      "UPLOADED",
      "QUEUED",
      "TRANSCRIBING",
      "SUMMARIZING",
      "EXTRACTING",
      "READY",
      "FAILED",
    ] as const;
    for (const s of stages) {
      // An unlabelled status renders the raw enum in the UI.
      expect(statusLabel(s)).not.toBe(s);
      expect(statusLabel(s).length).toBeGreaterThan(0);
    }
  });
});
