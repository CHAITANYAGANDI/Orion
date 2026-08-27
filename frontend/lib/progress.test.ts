import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderHook, act } from "@testing-library/react";
import {
  clampToStage,
  easeWithin,
  resetMeetingProgress,
  stageBand,
  useMeetingProgress,
} from "@/lib/progress";
import { statusProgress } from "@/lib/format";
import type { MeetingStatus } from "@/lib/types";

/**
 * The percentage on the processing card.
 *
 * <p>What is worth testing here is not the arithmetic — it is that a number fed
 * by two sources that disagree still only ever goes one way. It did not: the
 * worker opened a meeting at 10 while the browser's status table read 25 for
 * QUEUED, so every meeting's bar visibly fell from 25% to 10% the moment work
 * started.
 *
 * <p>So there are two kinds of test below. The contract tests pin the two
 * ladders to each other and would have failed on the old numbers. The hook
 * tests say that even if a future ladder drifts, the bar still cannot rewind.
 */

/**
 * The worker's ladder, copied by hand from `PROGRESS_*` in
 * ai-service/app/pipeline.py.
 *
 * <p>Nothing imports across the two languages, so this list is the only place
 * the contract is checked. Change those constants without changing these and
 * these tests are what says so.
 */
const WORKER_EVENTS: Array<[MeetingStatus, number]> = [
  ["TRANSCRIBING", 5], // PROGRESS_TRANSCRIBING - transcription starts
  ["TRANSCRIBING", 55], // PROGRESS_TRANSCRIBED  - transcript ready
  ["SUMMARIZING", 60], // PROGRESS_SUMMARIZING  - summarizing
  ["EXTRACTING", 90], // PROGRESS_EXTRACTING   - extracting action items
  ["READY", 100], // PROGRESS_DONE
];

/**
 * The same constants, read out of the Python they actually live in.
 *
 * <p>A list copied by hand is only as good as whoever last copied it, and the
 * bug this file exists for was two hand-maintained ladders drifting apart. So
 * this reads the source of truth instead. It returns null when ai-service is
 * not on disk — a frontend-only checkout or build container — because a test
 * that cannot see the other half of the contract has nothing to say about it,
 * and failing there would only teach people to ignore it.
 */
function workerLadder(): Record<string, number> | null {
  try {
    const source = readFileSync(
      resolve(__dirname, "../../ai-service/app/pipeline.py"),
      "utf8",
    );
    const found: Record<string, number> = {};
    for (const [, name, value] of source.matchAll(/^PROGRESS_(\w+)\s*=\s*(\d+)\s*$/gm)) {
      found[name] = Number(value);
    }
    return Object.keys(found).length ? found : null;
  } catch {
    return null;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the two ladders", () => {
  it("has no step down anywhere in the sequence a real meeting produces", () => {
    // Statuses the browser sees before the worker has said anything, then every
    // event the worker sends. This is the whole life of a meeting, in order.
    const sequence = [
      statusProgress("CREATED"),
      statusProgress("UPLOADED"),
      statusProgress("QUEUED"),
      ...WORKER_EVENTS.map(([, value]) => value),
    ];

    // The old numbers were 5, 15, 25 followed by 10 -- this is the assertion
    // that was failing in front of somebody watching a bar.
    expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
  });

  it("puts every number the worker sends inside the stage it sends it with", () => {
    for (const [status, value] of WORKER_EVENTS) {
      const { floor, ceiling } = stageBand(status);
      expect(value).toBeGreaterThanOrEqual(floor);
      expect(value).toBeLessThanOrEqual(ceiling);
      // Clamping a value the worker really sends must change nothing. If it
      // does, the two ladders have come apart again.
      expect(clampToStage(status, value)).toBe(value);
    }
  });

  it("matches the numbers ai-service actually sends", () => {
    const ladder = workerLadder();
    if (!ladder) {
      console.warn("ai-service not on disk; the worker half of the ladder was not checked.");
      return;
    }
    // Both names land on TRANSCRIBING: the stage reports twice, at its floor
    // and again once the transcript is in hand.
    expect(ladder).toEqual({
      TRANSCRIBING: 5,
      TRANSCRIBED: 55,
      SUMMARIZING: 60,
      EXTRACTING: 90,
      DONE: 100,
    });
    // And every one of them is a value the browser would accept unchanged.
    const byStatus: Array<[MeetingStatus, number]> = [
      ["TRANSCRIBING", ladder.TRANSCRIBING],
      ["TRANSCRIBING", ladder.TRANSCRIBED],
      ["SUMMARIZING", ladder.SUMMARIZING],
      ["EXTRACTING", ladder.EXTRACTING],
      ["READY", ladder.DONE],
    ];
    expect(byStatus).toEqual(WORKER_EVENTS);
    for (const [status, value] of byStatus) {
      expect(clampToStage(status, value)).toBe(value);
    }
  });

  it("opens near zero rather than a quarter full", () => {
    // A meeting accepted a second ago has had nothing done to it, and a bar
    // already at 25% promises a wait four times shorter than the real one.
    expect(statusProgress("CREATED")).toBeLessThanOrEqual(2);
    expect(statusProgress("QUEUED")).toBeLessThanOrEqual(5);
  });

  it("leaves no gap between one stage's ceiling and the next stage's floor", () => {
    const order: MeetingStatus[] = [
      "CREATED",
      "UPLOADED",
      "QUEUED",
      "TRANSCRIBING",
      "SUMMARIZING",
      "EXTRACTING",
      "READY",
    ];
    for (let i = 0; i < order.length - 1; i += 1) {
      const here = stageBand(order[i]);
      const next = stageBand(order[i + 1]);
      expect(here.floor).toBeLessThanOrEqual(here.ceiling);
      // A stage may never reach into the next one's territory: that is what
      // makes a stale event from a later stage safe to clamp.
      expect(here.ceiling).toBeLessThanOrEqual(next.floor);
    }
  });

  it("ends a failure at the end rather than back at zero", () => {
    // An empty bar beside a "Processing failed" card reads as a job that never
    // started. The worker sends 100 for this too.
    expect(clampToStage("FAILED", 100)).toBe(100);
    expect(clampToStage("FAILED", 0)).toBe(100);
  });
});

describe("easeWithin", () => {
  it("is at the floor the moment a stage begins", () => {
    expect(easeWithin(5, 59, 90_000, 0)).toBe(5);
  });

  it("does not move for a stage that was given no time constant", () => {
    expect(easeWithin(100, 100, 0, 60_000)).toBe(100);
    expect(easeWithin(5, 59, 0, 60_000)).toBe(5);
  });

  it("moves forward and keeps slowing down", () => {
    const at = (ms: number) => easeWithin(5, 59, 90_000, ms);
    const first = at(30_000) - at(0);
    const second = at(60_000) - at(30_000);
    const third = at(90_000) - at(60_000);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
    expect(second).toBeLessThan(first);
    expect(third).toBeLessThan(second);
  });

  it("never leaves the band, however long the stage runs", () => {
    // A meeting can be an hour of audio. The estimate must still not wander
    // into the next stage's numbers, let alone reach 100.
    expect(easeWithin(5, 59, 90_000, 60 * 60_000)).toBeLessThanOrEqual(59);
    expect(easeWithin(5, 59, 90_000, 60_000)).toBeLessThan(59);
  });
});

/** Drive the hook the way the page does: a status and whatever was last heard. */
function follow(id: string, status: MeetingStatus, reported: number) {
  return renderHook(
    ({ meetingId, status: s, reported: r }: {
      meetingId: string;
      status: MeetingStatus;
      reported: number;
    }) => useMeetingProgress(meetingId, s, r),
    { initialProps: { meetingId: id, status, reported } },
  );
}

describe("useMeetingProgress", () => {
  // The bar's memory belongs to the meeting rather than to the component that
  // draws it, so it survives a navigation -- which means it also survives from
  // one test into the next, and every test here uses "mtg_1".
  beforeEach(() => resetMeetingProgress());

  it("never goes backwards across a real run, polls included", () => {
    const { result, rerender } = follow("mtg_1", "QUEUED", statusProgress("QUEUED"));
    const seen = [result.current];

    // Every message in order, with the 5-second poll landing between events.
    // The poll only knows the stage, so it answers with the stage's floor --
    // which is lower than the number the socket already delivered.
    const messages: Array<[MeetingStatus, number]> = [
      ["TRANSCRIBING", 5],
      ["TRANSCRIBING", 5], // poll
      ["TRANSCRIBING", 55],
      ["TRANSCRIBING", 5], // poll, now well behind
      ["SUMMARIZING", 60],
      ["SUMMARIZING", 60], // poll
      ["EXTRACTING", 90],
      ["READY", 100],
    ];
    for (const [status, reported] of messages) {
      rerender({ meetingId: "mtg_1", status, reported });
      seen.push(result.current);
    }

    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen[0]).toBeLessThanOrEqual(5);
    expect(seen[seen.length - 1]).toBe(100);
  });

  it("keeps the higher number when the poll repeats a stage floor", () => {
    const { result, rerender } = follow("mtg_1", "TRANSCRIBING", 55);
    expect(result.current).toBeGreaterThanOrEqual(55);

    rerender({ meetingId: "mtg_1", status: "TRANSCRIBING", reported: 5 });
    expect(result.current).toBeGreaterThanOrEqual(55);
  });

  it("ignores a finished event left over from the run before", () => {
    // Reprocess re-queues the meeting. Until the worker speaks, the page may
    // still be holding the READY event from last time.
    const { result } = follow("mtg_1", "QUEUED", 100);
    expect(result.current).toBeLessThanOrEqual(stageBand("QUEUED").ceiling);
  });

  it("starts again when a finished meeting is put back to work", () => {
    const { result, rerender } = follow("mtg_1", "READY", 100);
    expect(result.current).toBe(100);

    // A reprocess: the same meeting, leaving a terminal status. The one time
    // the bar is supposed to rewind.
    rerender({ meetingId: "mtg_1", status: "QUEUED", reported: statusProgress("QUEUED") });
    expect(result.current).toBe(statusProgress("QUEUED"));
  });

  it("starts again for a different meeting", () => {
    const { result, rerender } = follow("mtg_1", "EXTRACTING", 90);
    expect(result.current).toBe(90);

    rerender({ meetingId: "mtg_2", status: "QUEUED", reported: statusProgress("QUEUED") });
    expect(result.current).toBe(statusProgress("QUEUED"));
  });

  it("keeps moving while a stage reports nothing", () => {
    vi.useFakeTimers();
    const { result } = follow("mtg_1", "TRANSCRIBING", 5);
    const opened = result.current;

    // Transcription is most of the wait and reports twice. Without this the bar
    // sat on one number for minutes and then leapt.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    const later = result.current;
    expect(later).toBeGreaterThan(opened);
    expect(later).toBeLessThan(stageBand("TRANSCRIBING").ceiling);

    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    // Six minutes in, and it still has not claimed the next stage.
    expect(result.current).toBeLessThanOrEqual(stageBand("TRANSCRIBING").ceiling);
    expect(result.current).toBeLessThan(statusProgress("SUMMARIZING"));
  });

  it("stands still once the meeting is finished", () => {
    vi.useFakeTimers();
    const { result } = follow("mtg_1", "READY", 100);
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(result.current).toBe(100);
  });
});

/**
 * Leaving the page and coming back.
 *
 * <p>The bug, reported from a real meeting: the bar read 6%, the user went to
 * Home and came back, and it read 6% again — on a job that had been running for
 * minutes. Then Home showed 5%, then the meeting showed 5%, back and forth,
 * because each surface started a fresh clock on mount.
 *
 * <p>The cause was that the memory lived in a `useRef`, and a navigation is an
 * unmount. It is keyed by meeting id in a module map now, so every surface reads
 * the same number and none of them can rewind it.
 */
describe("surviving a navigation", () => {
  beforeEach(() => resetMeetingProgress());

  it("does not rewind when the component is unmounted and mounted again", () => {
    vi.useFakeTimers();
    try {
      const first = follow("mtg_nav", "TRANSCRIBING", statusProgress("TRANSCRIBING"));
      // Four minutes into the stage, so the estimate has climbed well clear of
      // the 5% floor.
      act(() => void vi.advanceTimersByTime(240_000));
      const before = first.result.current;
      expect(before).toBeGreaterThan(20);

      // Going to Home is an unmount; coming back is a fresh mount.
      first.unmount();
      const second = follow("mtg_nav", "TRANSCRIBING", statusProgress("TRANSCRIBING"));

      expect(second.result.current).toBeGreaterThanOrEqual(before);
      // The specific number from the report: it must not be the stage floor.
      expect(second.result.current).not.toBe(statusProgress("TRANSCRIBING"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows one number to two surfaces watching the same meeting", () => {
    // The list row and the docked bar are both drawing the same job. Two
    // independent clocks would put two different percentages on one meeting.
    vi.useFakeTimers();
    try {
      const row = follow("mtg_two", "TRANSCRIBING", statusProgress("TRANSCRIBING"));
      act(() => void vi.advanceTimersByTime(60_000));
      const dock = follow("mtg_two", "TRANSCRIBING", statusProgress("TRANSCRIBING"));

      expect(dock.result.current).toBe(row.result.current);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still gives a different meeting its own clock", () => {
    // Sharing by id, not globally: opening a second meeting must not inherit
    // the first one's percentage.
    vi.useFakeTimers();
    try {
      const a = follow("mtg_a", "TRANSCRIBING", statusProgress("TRANSCRIBING"));
      act(() => void vi.advanceTimersByTime(240_000));
      expect(a.result.current).toBeGreaterThan(20);

      const b = follow("mtg_b", "QUEUED", statusProgress("QUEUED"));

      expect(b.result.current).toBeLessThanOrEqual(stageBand("QUEUED").ceiling);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still rewinds for a reprocess, which is the one time it should", () => {
    const { result, rerender } = follow("mtg_re", "READY", 100);
    expect(result.current).toBe(100);

    rerender({ meetingId: "mtg_re", status: "QUEUED", reported: statusProgress("QUEUED") });

    expect(result.current).toBeLessThanOrEqual(stageBand("QUEUED").ceiling);
  });
});
