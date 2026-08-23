"use client";

/**
 * The one number somebody watches while a meeting is processed.
 *
 * <p><b>Why this file exists.</b> The percentage has two sources that cannot be
 * reduced to one. The worker pushes a stage event over the WebSocket; the
 * browser also polls the meeting's status, because a proxy that drops the
 * socket would otherwise leave the bar frozen over a meeting that was ready
 * minutes ago. Whichever spoke last used to win, and the two did not agree on
 * what a stage was worth — the worker opened at 10 while the status table read
 * 25 for QUEUED — so the first event of every meeting moved the bar from 25%
 * *down* to 10%. Backwards, at the exact moment work began, which is what a
 * failed retry looks like.
 *
 * <p>Aligning the two ladders (see `statusProgress` and `PROGRESS_*` in
 * ai-service/app/pipeline.py) removes the disagreement. This module removes the
 * possibility, and adds the two things a ladder alone cannot give:
 *
 * <ol>
 *   <li><b>It never goes down.</b> Not for a late event, not for a poll that
 *       repeats a stage floor the socket has already moved past, not for a
 *       future worker whose numbers drift. Monotonic is enforced here rather
 *       than assumed of everyone upstream.</li>
 *   <li><b>It moves between stages.</b> Transcription is most of the wait and
 *       reports exactly twice, so without this the bar sat on one number for
 *       minutes and then leapt. The movement in between is an estimate from the
 *       clock and is described as such below.</li>
 * </ol>
 */

import * as React from "react";
import { statusProgress, isTerminal } from "@/lib/format";
import type { MeetingStatus } from "@/lib/types";

/** How often the estimate is repainted while a stage is running. */
const TICK_MS = 500;

/**
 * The band each status may occupy, and how quickly the estimate crosses it.
 *
 * <p>`floor` is the status's own percentage and comes from `statusProgress`, so
 * it is not repeated here. `ceiling` is the highest number that status is ever
 * allowed to show — the next stage owns everything above it. `tau` is the time
 * constant of the drift across the band: after `tau` the estimate has covered
 * about 63% of it, after three `tau` about 95%, and it never arrives.
 *
 * <p>The ceilings are what make a stale event harmless. A reported percentage
 * is clamped into the band of the status it claims to be in, so a READY event
 * left over from a previous run cannot show 100% over a meeting that has just
 * been re-queued — it is a QUEUED meeting, so it may show 3.
 *
 * <p>`tau` is guesswork about how long a stage takes, and nothing more. It is
 * not derived from the recording's length and does not shorten if the work
 * finishes early; the worker's next event does that. Its only job is to keep
 * the bar from reading as hung.
 */
const BANDS: Record<MeetingStatus, { ceiling: number; tau: number }> = {
  CREATED: { ceiling: 1, tau: 0 },
  UPLOADED: { ceiling: 2, tau: 0 },
  QUEUED: { ceiling: 4, tau: 5_000 },
  // The long one. Two events across it — "started" at the floor and "transcript
  // ready" at 55 — with everything the provider does in between.
  TRANSCRIBING: { ceiling: 59, tau: 90_000 },
  SUMMARIZING: { ceiling: 89, tau: 25_000 },
  EXTRACTING: { ceiling: 99, tau: 10_000 },
  READY: { ceiling: 100, tau: 0 },
  FAILED: { ceiling: 100, tau: 0 },
};

/** The band a status may show within: `[floor, ceiling]`, both inclusive. */
export function stageBand(status: MeetingStatus): { floor: number; ceiling: number; tau: number } {
  const floor = statusProgress(status);
  const band = BANDS[status];
  // An unrecognised status from a newer server: hold at its floor rather than
  // invent a band for something this build does not know the shape of.
  if (!band) return { floor, ceiling: floor, tau: 0 };
  return { floor, ceiling: Math.max(floor, band.ceiling), tau: band.tau };
}

/**
 * Where the estimate has drifted to after `elapsedMs` in a stage.
 *
 * <p>Exponential rather than linear, so it decelerates: a bar that crosses its
 * band at a constant rate and then stops dead at the ceiling makes a promise
 * about the finish time that nothing here can keep. Approaching the ceiling
 * without reaching it says "still working" and claims nothing else.
 */
export function easeWithin(floor: number, ceiling: number, tau: number, elapsedMs: number): number {
  if (tau <= 0 || ceiling <= floor || elapsedMs <= 0) return floor;
  return floor + (ceiling - floor) * (1 - Math.exp(-elapsedMs / tau));
}

/** Pull a reported percentage into the band of the status it claims to be in. */
export function clampToStage(status: MeetingStatus, reported: number): number {
  const { floor, ceiling } = stageBand(status);
  if (!Number.isFinite(reported)) return floor;
  return Math.min(ceiling, Math.max(floor, reported));
}

interface Run {
  /** The meeting this number is about. */
  id: string;
  /** The highest value already shown for it. */
  shown: number;
  /** The stage being timed, and since when. */
  stage: MeetingStatus | null;
  since: number;
  /** Whether the last thing we saw was a finished meeting. */
  settled: boolean;
}

/**
 * The percentage to draw, given what the server last said.
 *
 * <p>`reported` is whatever is freshest — a live event's `progress`, or
 * `statusProgress` of a polled status. It is a suggestion: this returns the
 * highest of that, the stage's floor, and the clock's estimate, and never less
 * than it returned a moment ago.
 *
 * <p><b>It resets for a new run, and only for a new run.</b> A different
 * meeting is obviously one. So is a reprocess, which puts a finished meeting
 * back to the beginning — the only case where the bar is *supposed* to rewind,
 * detected as a meeting leaving a terminal status rather than by anyone
 * remembering to clear something.
 *
 * <p>One honest limitation: opening a page mid-transcription starts the stage
 * clock at that moment, so the estimate begins from the floor again. Nothing
 * stored says when the stage actually began, and the clamp means this can only
 * ever under-report.
 */
export function useMeetingProgress(
  meetingId: string,
  status: MeetingStatus,
  reported: number,
): number {
  const terminal = isTerminal(status);
  const run = React.useRef<Run>({ id: "", shown: 0, stage: null, since: 0, settled: false });
  const [, repaint] = React.useReducer((n: number) => n + 1, 0);

  // Only while something is moving. A finished meeting has nothing to redraw,
  // and a timer left running under one would tick for as long as the tab stayed
  // open on it.
  React.useEffect(() => {
    if (terminal) return;
    const timer = setInterval(repaint, TICK_MS);
    return () => clearInterval(timer);
  }, [terminal]);

  const now = Date.now();
  const state = run.current;

  const restarted = state.id !== meetingId || (state.settled && !terminal);
  if (restarted) {
    state.id = meetingId;
    state.shown = 0;
    state.stage = null;
    state.since = now;
  }
  state.settled = terminal;

  if (state.stage !== status) {
    state.stage = status;
    state.since = now;
  }

  const { floor, ceiling, tau } = stageBand(status);
  const estimate = terminal ? floor : easeWithin(floor, ceiling, tau, now - state.since);
  state.shown = Math.max(state.shown, clampToStage(status, reported), estimate);
  return state.shown;
}
