import { describe, it, expect } from "vitest";
import {
  RETENTION_CHOICES,
  retentionLabel,
  DELETE_PHRASE,
  confirmsDeletion,
  RECORDING_ANNOUNCEMENT,
  privacyError,
} from "@/lib/privacy";

/**
 * The small, exact parts of the privacy controls.
 *
 * <p>Two of these guard against a specific failure rather than a general one.
 * The confirmation phrase is checked in two places — here so the button can be
 * disabled, and again on the server — and if the two ever disagree the button
 * becomes either useless or a lie. And the retention windows are the vocabulary
 * of a promise made to other people about their voices, so a free-text field
 * creeping in later would be a regression, not a feature.
 */
describe("the confirmation phrase", () => {
  it("is the one the server checks for", () => {
    // If this changes, PrivacyService.DELETE_PHRASE changes with it or the
    // button enables on words the API will refuse.
    expect(DELETE_PHRASE).toBe("delete everything");
  });

  it("accepts the phrase however it was spaced or cased", () => {
    expect(confirmsDeletion("delete everything")).toBe(true);
    expect(confirmsDeletion("  Delete Everything  ")).toBe(true);
    expect(confirmsDeletion("DELETE EVERYTHING")).toBe(true);
  });

  it("refuses anything else, including the near misses", () => {
    expect(confirmsDeletion("")).toBe(false);
    expect(confirmsDeletion("yes")).toBe(false);
    expect(confirmsDeletion("delete")).toBe(false);
    expect(confirmsDeletion("delete everything please")).toBe(false);
  });
});

describe("the retention windows", () => {
  it("offers keeping forever first, which is the default and the safe answer", () => {
    expect(RETENTION_CHOICES[0]).toEqual({ days: null, label: "Never" });
  });

  it("offers three genuinely different answers and no fourth", () => {
    // 90 days, 6 months and a year were all on this list and all meant
    // "eventually". Never, a week and a month are decisions.
    expect(RETENTION_CHOICES.map((c) => c.days)).toEqual([null, 7, 30]);
  });

  it("stays inside the range the database will accept", () => {
    const days = RETENTION_CHOICES.map((c) => c.days).filter((d): d is number => d !== null);
    expect(Math.min(...days)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...days)).toBeLessThanOrEqual(3650);
  });

  it("names a window the interface no longer offers rather than mislabelling it", () => {
    // The API still takes 1..3650. A policy of 90 days set before this list
    // shrank has to read as 90 days, not as "After a month".
    expect(retentionLabel(90)).toBe("After 90 days");
    expect(retentionLabel(null)).toBe("Never");
    expect(retentionLabel(7)).toBe("After a week");
  });
});

describe("the announcement", () => {
  it("names Recallix, says what it does, and leaves room to object", () => {
    expect(RECORDING_ANNOUNCEMENT).toContain("recording this meeting");
    expect(RECORDING_ANNOUNCEMENT).toContain("Recallix");
    expect(RECORDING_ANNOUNCEMENT).toContain("rather I didn't");
  });
});

describe("reporting a refusal", () => {
  it("prefers the API's own sentence, which explains what went wrong", () => {
    expect(
      privacyError({ data: { message: "Keep meetings at least as long as recordings." } }),
    ).toBe("Keep meetings at least as long as recordings.");
  });

  it("falls back to an error's message, then to something generic", () => {
    expect(privacyError(new Error("offline"))).toBe("offline");
    expect(privacyError(undefined)).toBe("Something went wrong");
  });
});
