import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  trackProcessing,
  untrackProcessing,
  processingJobs,
  resetProcessingJobs,
  useProcessingJobs,
  isOpening,
  releaseOpening,
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

const KEY = "recallix:processing";

/**
 * The gap between tracking a job and arriving at its page.
 *
 * <p>Saving a recording does both in one breath, and it has to: watching must
 * start the moment the meeting exists, or a save followed by a wander somewhere
 * else loses the completion. But a route change is not instant, and until it
 * lands the pathname is still the page being left — so the dock's rule ("not
 * the meeting you are looking at") cannot yet see what is about to be on
 * screen, and drew a bar for the length of the navigation. A flash in the
 * corner, at the exact moment of a successful save.
 *
 * <p>The fix is a fact, not a delay: where the job set off from. Everything
 * below is about it being released reliably, because a job stuck as "opening"
 * would be a job that is watched and never shown.
 */
describe("a job whose page is being opened", () => {
  beforeEach(() => {
    resetProcessingJobs();
    window.sessionStorage.clear();
  });

  it("is watched from the moment it is tracked, exactly as any other", () => {
    // The half that must not be traded away for the half below.
    trackProcessing("mtg_1", "/record");

    expect(processingJobs()).toEqual(["mtg_1"]);
  });

  it("is held back only while the user is still standing where it set off", () => {
    trackProcessing("mtg_1", "/record");

    expect(isOpening("mtg_1", "/record")).toBe(true);
    expect(isOpening("mtg_1", "/meetings/mtg_1")).toBe(false);
  });

  it("holds nothing back when no origin was given", () => {
    // The meeting page tracks what it is already showing. There is no
    // navigation in flight, so there is nothing to wait for.
    trackProcessing("mtg_1");

    expect(isOpening("mtg_1", "/record")).toBe(false);
  });

  it("does not forget the origin when the same job is tracked again", () => {
    // The meeting page tracks the id again on arrival. That call must not be
    // what decides whether the dock held it back on the way there.
    trackProcessing("mtg_1", "/record");
    trackProcessing("mtg_1");

    expect(isOpening("mtg_1", "/record")).toBe(true);
  });

  it("lets go as soon as the route is anywhere else", () => {
    trackProcessing("mtg_1", "/record");

    releaseOpening("/meetings/mtg_1");

    expect(isOpening("mtg_1", "/record")).toBe(false);
  });

  it("lets go even when the navigation went somewhere unexpected", () => {
    // Released on any change, not on arrival at the meeting. A push that is
    // overtaken by a back button must not leave the job hidden for ever, and
    // there is no timer here to rescue it.
    trackProcessing("mtg_1", "/record");

    releaseOpening("/home");

    expect(isOpening("mtg_1", "/record")).toBe(false);
  });

  it("holds on while the route has not moved", () => {
    // Called on every render of the dock, including the ones before the push
    // resolves. Releasing there would be releasing immediately.
    trackProcessing("mtg_1", "/record");

    releaseOpening("/record");

    expect(isOpening("mtg_1", "/record")).toBe(true);
  });

  it("re-renders the dock when it lets go", () => {
    // Otherwise a job released after the navigation would stay hidden until
    // something unrelated happened to re-render.
    const { result } = renderHook(() => useProcessingJobs());
    act(() => trackProcessing("mtg_1", "/record"));
    const held = result.current;

    act(() => releaseOpening("/home"));

    expect(result.current).not.toBe(held);
  });

  it("says nothing on a navigation with nothing waiting", () => {
    // Which is almost every navigation. A fresh snapshot each time would be a
    // re-render of the dock on every route change for nothing.
    const { result } = renderHook(() => useProcessingJobs());
    act(() => trackProcessing("mtg_1"));
    const before = result.current;

    act(() => releaseOpening("/home"));

    expect(result.current).toBe(before);
  });

  it("forgets the origin when the job is dropped", () => {
    trackProcessing("mtg_1", "/record");

    untrackProcessing("mtg_1");
    trackProcessing("mtg_1");

    // Tracked again later from somewhere else: it is an ordinary job now, and
    // a stale origin would hide it on any return to /record.
    expect(isOpening("mtg_1", "/record")).toBe(false);
  });
});
