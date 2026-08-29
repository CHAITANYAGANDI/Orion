import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * What finishing a meeting has to invalidate.
 *
 * <h2>The bug</h2>
 *
 * <p>When a meeting reached READY the badge flipped to Ready and Home stopped
 * saying "Processing" — and the page behind it still showed no summary, no
 * transcript and no action items until you refreshed or switched tabs and back.
 *
 * <p>It looked as though the backend had not finished. It had. The AI result
 * callback writes the transcript, the summary, the action items and the
 * insights in the same transaction that sets READY. The watcher invalidated
 * only `Meeting` and `Meetings` — the two tags the *status* lives in — so RTK
 * Query went on serving the empty results it had cached while the meeting was
 * still processing. Switching tabs "fixed" it because remounting refetches.
 *
 * <p>The tag list is asserted directly rather than through a rendered tree.
 * These are opaque strings that have to match `providesTags` in lib/api.ts
 * exactly, and getting one wrong fails silently in the direction of stale data
 * — which is the failure being fixed, so it needs to be caught by name.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { completedMeetingTags } from "@/components/processing-dock";

/** The shape RTK Query tags take, for readable assertions below. */
type Tag = { type: string; id: string };

const MEETING = "mtg_1";

function tagsFor(meetingId: string): Tag[] {
  return completedMeetingTags(meetingId) as unknown as Tag[];
}

function has(tags: Tag[], type: string, id: string): boolean {
  return tags.some((t) => t.type === type && t.id === id);
}

describe("completedMeetingTags", () => {
  it("invalidates the three the user actually came for", () => {
    // The regression, stated as the three things that were missing. Every one
    // of these is written by the result callback and was being served stale.
    const tags = tagsFor(MEETING);

    expect(has(tags, "Transcript", MEETING)).toBe(true);
    expect(has(tags, "Summary", MEETING)).toBe(true);
    expect(has(tags, "ActionItems", "LIST")).toBe(true);
  });

  it("still invalidates the status tags it always did", () => {
    // The fix must not trade one stale panel for another: these two are what
    // stop Home listing a finished meeting as still processing.
    const tags = tagsFor(MEETING);

    expect(has(tags, "Meeting", MEETING)).toBe(true);
    expect(has(tags, "Meetings", "LIST")).toBe(true);
  });

  it("invalidates the rest of what the callback writes", () => {
    const tags = tagsFor(MEETING);

    expect(has(tags, "Insights", MEETING)).toBe(true);
    expect(has(tags, "Moments", MEETING)).toBe(true);
  });

  it("invalidates the allowance, which is charged on completion", () => {
    // Transcribed minutes are billed when the job completes, so the number in
    // the sidebar is wrong from that moment until something refetches it.
    expect(has(tagsFor(MEETING), "Usage", "ME")).toBe(true);
  });

  it("keys per-meeting tags to the meeting being settled", () => {
    // A tag keyed to the wrong id invalidates nothing and reports no error.
    // This is what stops the whole list above passing while doing nothing.
    const tags = tagsFor("mtg_other");

    expect(has(tags, "Transcript", "mtg_other")).toBe(true);
    expect(has(tags, "Transcript", MEETING)).toBe(false);
    expect(has(tags, "Summary", MEETING)).toBe(false);
  });

  it("uses LIST for the two collections that are not per-meeting", () => {
    // `ActionItems` is queried across meetings and filtered by id, so there is
    // no per-meeting tag to invalidate; `Meetings` is the same. Tagging either
    // with a meeting id would silently miss.
    const tags = tagsFor(MEETING);

    expect(has(tags, "ActionItems", MEETING)).toBe(false);
    expect(has(tags, "Meetings", MEETING)).toBe(false);
  });

  it("names only tag types the api actually declares", () => {
    /*
     * Guards against a typo in a tag string, which fails by quietly
     * invalidating nothing -- the same silent-staleness failure this file
     * exists for.
     *
     * Read from the source of lib/api.ts rather than from the api object:
     * `createApi` does not keep `tagTypes` at runtime, so introspecting the
     * instance returns undefined and any assertion against it passes
     * vacuously. Checked, and it does.
     */
    const source = readFileSync(resolve(__dirname, "../lib/api.ts"), "utf8");
    const block = source.slice(source.indexOf("tagTypes: ["));
    const declared = new Set(
      block
        .slice(0, block.indexOf("]"))
        .match(/"[A-Za-z]+"/g)
        ?.map((q) => q.slice(1, -1)) ?? [],
    );

    expect(declared.size).toBeGreaterThan(5);
    for (const tag of tagsFor(MEETING)) {
      expect(declared, `tag type "${tag.type}"`).toContain(tag.type);
    }
  });
});

/**
 * The watcher dispatches those tags when a tracked meeting reaches READY.
 *
 * <p>The list above is worth nothing if nothing sends it. This renders the real
 * component with the meeting already READY and asserts the dispatch, so the
 * wiring is covered as well as the payload.
 */
describe("JobWatcher settling", () => {
  const dispatch = vi.fn();
  const untrack = vi.fn();

  beforeEach(() => {
    dispatch.mockClear();
    untrack.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@/lib/api");
    vi.doUnmock("@/lib/hooks");
    vi.doUnmock("@/lib/ws");
    vi.doUnmock("@/lib/processing-jobs");
  });

  it("dispatches an invalidation carrying the transcript and summary tags", async () => {
    vi.doMock("@/lib/hooks", () => ({ useAppDispatch: () => dispatch }));
    vi.doMock("@/lib/ws", () => ({
      subscribeMeetingStatus: () => ({ deactivate: () => {} }),
    }));
    vi.doMock("@/lib/processing-jobs", () => ({
      useProcessingJobs: () => [MEETING],
      untrackProcessing: untrack,
    }));

    const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
    vi.doMock("@/lib/api", () => ({
      ...actual,
      // Already READY on the first read, which is the state the watcher settles
      // on. `sawRunning` stays false so no toast fires -- deliberate: this is
      // about the cache, and asserting the toast here would couple the two.
      useGetMeetingQuery: () => ({ data: { id: MEETING, status: "READY", title: "Standup" } }),
    }));

    const [{ ProcessingDock }, { render }, React] = await Promise.all([
      import("@/components/processing-dock"),
      import("@testing-library/react"),
      import("react"),
    ]);

    render(React.createElement(ProcessingDock));

    expect(dispatch).toHaveBeenCalled();
    const payloads = dispatch.mock.calls
      .map(([action]) => (action as { payload?: unknown }).payload)
      .filter(Array.isArray) as Tag[][];
    const invalidated = payloads.flat();

    expect(has(invalidated, "Transcript", MEETING)).toBe(true);
    expect(has(invalidated, "Summary", MEETING)).toBe(true);
    expect(has(invalidated, "ActionItems", "LIST")).toBe(true);
    expect(has(invalidated, "Meeting", MEETING)).toBe(true);
    // And it stops watching, so the 5s poll does not outlive the job.
    expect(untrack).toHaveBeenCalledWith(MEETING);
  });
});
