import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  trackProcessing,
  untrackProcessing,
  processingJobs,
  resetProcessingJobs,
  useProcessingJobs,
} from "@/lib/processing-jobs";

/**
 * What this tab is watching.
 *
 * <p>The store holds ids, never statuses. That is the property most worth
 * pinning: an id in here means "watch this", and whether the meeting is
 * actually unfinished is decided by the server on every poll. A store that
 * cached the status would be a second source of truth for the one thing this
 * whole change is about — a meeting that finished while nobody was looking.
 */
describe("processing jobs", () => {
  beforeEach(() => {
    resetProcessingJobs();
    window.sessionStorage.clear();
  });

  it("remembers a meeting it was asked to watch", () => {
    trackProcessing("mtg_1");

    expect(processingJobs()).toEqual(["mtg_1"]);
  });

  it("counts the same meeting once", () => {
    // The meeting page tracks on every render where the meeting is unfinished,
    // and the save path tracks it too. Both firing must be one job, not two
    // cards stacked in the corner polling the same id.
    trackProcessing("mtg_1");
    trackProcessing("mtg_1");

    expect(processingJobs()).toEqual(["mtg_1"]);
  });

  it("watches several at once", () => {
    // Importing three files in a row is one press each and three jobs.
    trackProcessing("mtg_1");
    trackProcessing("mtg_2");

    expect(processingJobs()).toEqual(["mtg_1", "mtg_2"]);
  });

  it("forgets one without disturbing the others", () => {
    trackProcessing("mtg_1");
    trackProcessing("mtg_2");

    untrackProcessing("mtg_1");

    expect(processingJobs()).toEqual(["mtg_2"]);
  });

  it("ignores an untrack for something it never had", () => {
    trackProcessing("mtg_1");

    untrackProcessing("mtg_nope");

    expect(processingJobs()).toEqual(["mtg_1"]);
  });

  it("ignores a blank id", () => {
    // A create that failed halfway leaves an empty string in some paths, and a
    // job with no meeting is a card that links to /meetings/ and polls nothing.
    trackProcessing("");

    expect(processingJobs()).toEqual([]);
  });

  it("writes what it is watching through to the tab's storage", () => {
    trackProcessing("mtg_1");

    expect(JSON.parse(window.sessionStorage.getItem(KEY) ?? "null")).toEqual(["mtg_1"]);
  });

  it("survives a reload of the tab", async () => {
    window.sessionStorage.setItem(KEY, JSON.stringify(["mtg_1"]));
    // What a reload actually is: the module is evaluated afresh with an empty
    // list, and the stored copy is all that is left. Simulated by re-importing
    // rather than by poking `loaded`, so the lazy load is the thing under test.
    vi.resetModules();
    const fresh = await import("@/lib/processing-jobs");

    // Read through the hook, because subscribing is what triggers the load.
    const { result } = renderHook(() => fresh.useProcessingJobs());

    expect(result.current).toEqual(["mtg_1"]);
  });

  it("starts from nothing when the stored value is nonsense", async () => {
    // A corrupt entry must not be a crash on a cold start: watching nothing is
    // exactly what happened before this file existed.
    window.sessionStorage.setItem(KEY, "{not json");
    vi.resetModules();
    const fresh = await import("@/lib/processing-jobs");

    const { result } = renderHook(() => fresh.useProcessingJobs());

    expect(result.current).toEqual([]);
  });

  it("ignores stored entries that are not ids", async () => {
    window.sessionStorage.setItem(KEY, JSON.stringify(["mtg_1", null, 7, ""]));
    vi.resetModules();
    const fresh = await import("@/lib/processing-jobs");

    const { result } = renderHook(() => fresh.useProcessingJobs());

    expect(result.current).toEqual(["mtg_1"]);
  });

  it("re-renders whatever is reading it", () => {
    const { result } = renderHook(() => useProcessingJobs());
    expect(result.current).toEqual([]);

    act(() => trackProcessing("mtg_1"));

    expect(result.current).toEqual(["mtg_1"]);
  });

  it("hands out a stable snapshot between changes", () => {
    // Not a micro-optimisation. `useSyncExternalStore` compares snapshots with
    // Object.is, so a fresh array from getSnapshot every render is an infinite
    // render loop rather than a wasted render.
    const { result, rerender } = renderHook(() => useProcessingJobs());
    act(() => trackProcessing("mtg_1"));
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });
});

const KEY = "reverie:processing";
