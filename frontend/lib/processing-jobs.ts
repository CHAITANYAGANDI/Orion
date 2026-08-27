"use client";

/**
 * Which meetings are being processed right now, for the whole app.
 *
 * ## What this exists to fix
 *
 * Saving a recording pushed you to `/meetings/<id>`, and until the pipeline
 * finished that page was a single full-width card with a percentage on it.
 * Nothing else was rendered — no transcript, no chat, no player — because every
 * one of those is gated on `status === "READY"`. So a forty-minute recording
 * turned the app into a progress screen for eight minutes, and the only way out
 * was to navigate away and lose sight of the job entirely.
 *
 * Neither half of that is right. Processing is a *background* job: the ai-service
 * consumes from Kafka and never once looks at whether a browser is open, and
 * closing the tab has never stopped a meeting being transcribed. The interface
 * was the only thing implying otherwise.
 *
 * So the wait moves here — one small docked bar that follows you around — and
 * the meeting page keeps its own progress as a slim banner rather than as the
 * whole page. See components/processing-dock.tsx.
 *
 * ## Why a module store and not Redux
 *
 * The same reasoning as lib/active-chat: a set of ids shared between the dock,
 * the meeting page and three upload paths, with no reducer logic worth the name.
 * `useSyncExternalStore` is what that is for.
 *
 * ## Why it is written to sessionStorage
 *
 * A reload used to lose the job. That was defensible when the wait lived on the
 * meeting's own page — the page could read the status back from the server — and
 * it is not defensible for a dock that is the only thing on screen tracking it.
 * `sessionStorage` and not `localStorage`: this is "what this tab is watching",
 * and a job tracked in a tab you closed last Tuesday is noise.
 *
 * Nothing sensitive is stored. Meeting ids are opaque and are already in the
 * URL of the page that lists them.
 *
 * ## The store is not the source of truth
 *
 * It holds ids, not statuses. Whether a meeting is still processing is decided
 * by the server, every time, through the same `useGetMeetingQuery` the rest of
 * the app uses — so a job that finished while the tab was closed resolves on the
 * first poll and drops out. An id in here means "watch this", never "this is
 * unfinished".
 */

import { useCallback, useSyncExternalStore } from "react";

const KEY = "recallix:processing";

let ids: string[] = [];
const listeners = new Set<() => void>();

/**
 * The array handed to `useSyncExternalStore`, rebuilt only when it changes.
 *
 * Required, not a micro-optimisation: the hook compares snapshots with `Object.is`
 * and re-renders whenever they differ, so returning a fresh array from
 * `getSnapshot` is an infinite render loop rather than a wasted render.
 */
let snapshot: readonly string[] = [];

function emit(): void {
  snapshot = [...ids];
  try {
    // Best effort. Private-mode Safari throws on write, and a tracking
    // convenience must never be why a save fails.
    window.sessionStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* not being able to remember across a reload is survivable */
  }
  for (const listener of listeners) listener();
}

let loaded = false;

/**
 * Read back what this tab was watching before the reload.
 *
 * Lazy rather than at module scope: this file is imported by components that
 * render on the server during the initial pass, where `sessionStorage` does not
 * exist.
 */
function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      ids = parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
      snapshot = [...ids];
    }
  } catch {
    // A corrupt entry is not worth a crash on a cold start; watching nothing
    // is exactly what happens today without this file.
    ids = [];
    snapshot = [];
  }
}

function subscribe(listener: () => void): () => void {
  load();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Jobs whose own page the user is on their way to, and where they set off from.
 *
 * ## Why watching has to start before the navigation ends
 *
 * Saving a recording tracks the meeting and pushes to its page in the same
 * breath. Both are right: the job has to be watched from the moment it exists,
 * or a save followed by a wander somewhere else loses the completion entirely.
 *
 * But a route change is not instant. For the length of it `usePathname` still
 * answers `/record`, so the dock — whose one rule is "not the meeting you are
 * looking at" — could not yet tell that this was the meeting being opened. It
 * drew a bar for a job it was about to be told not to draw, and the whole of
 * that bar's life on screen was a flash in the corner between pressing Save and
 * arriving.
 *
 * ## What is remembered, and how it is let go
 *
 * The pathname the job set off from. The dock holds the job back while the user
 * is still standing on it, and releases it the moment the pathname is anything
 * else — see `releaseOpening`, called from the dock, which is the one place
 * that observes a navigation happening.
 *
 * Releasing on *any* change rather than on arrival at the meeting is what keeps
 * this from being a way to hide a job for ever. A navigation that never happens
 * is one where nothing moved on screen either, so there is nothing to be stuck
 * behind; no timer is needed and none is used.
 *
 * Deliberately not written to `sessionStorage`, unlike the ids themselves. This
 * describes one navigation in flight, and a reload is the end of that
 * navigation whatever became of it.
 */
const opening = new Map<string, string>();

/**
 * Start watching a meeting. Idempotent — the same id twice is one job.
 *
 * <p>`openingFrom` is for the one caller that tracks a meeting and immediately
 * sends the user to its page: the pathname it is leaving. Everyone else tracks
 * a meeting that is already somewhere else and passes nothing.
 */
export function trackProcessing(meetingId: string, openingFrom?: string): void {
  if (!meetingId) return;
  load();
  // Before the bail-out below, not after. The meeting page tracks the same id
  // again on arrival, and whether that call happens to be the first must not
  // decide whether the dock held the job back on the way there.
  if (openingFrom !== undefined) opening.set(meetingId, openingFrom);
  if (ids.includes(meetingId)) return;
  ids = [...ids, meetingId];
  emit();
}

/**
 * Whether this job is one the user is in the middle of being taken to.
 *
 * <p>Pure: it compares and does not clean up. `releaseOpening` does that, from
 * the one place that knows a navigation has happened.
 */
export function isOpening(meetingId: string, pathname: string): boolean {
  return opening.get(meetingId) === pathname;
}

/**
 * Let go of every job whose navigation is over.
 *
 * <p>"Over" means only that the pathname is no longer the one it set off from,
 * not that it arrived where it was going. Landing anywhere at all is enough: on
 * the meeting's own page the dock hides the job for its own reason, and
 * anywhere else it should be drawn like any other.
 */
export function releaseOpening(pathname: string): void {
  let changed = false;
  for (const [id, from] of opening) {
    if (from === pathname) continue;
    opening.delete(id);
    changed = true;
  }
  // Only when something actually moved. `emit` hands out a fresh snapshot, and
  // one on every navigation would re-render the dock for nothing.
  if (changed) emit();
}

/**
 * Stop watching. Called when the meeting reaches a terminal state, and by the
 * dismiss control on the dock.
 */
export function untrackProcessing(meetingId: string): void {
  load();
  opening.delete(meetingId);
  if (!ids.includes(meetingId)) return;
  ids = ids.filter((id) => id !== meetingId);
  emit();
}

/** Everything being watched, without subscribing. For event handlers. */
export function processingJobs(): readonly string[] {
  load();
  return snapshot;
}

/**
 * Exists so tests start from a clean sheet.
 *
 * <p>Clears the stored copy as well as the in-memory one, and leaves the store
 * marked as loaded. Both matter: `emit` writes through to `sessionStorage`, so
 * a reset that only emptied the array would be undone by the next lazy load,
 * and one test's meeting would still be watched in the next.
 *
 * <p>It is therefore not a way to simulate a page load. Use `vi.resetModules()`
 * and re-import for that, which is what actually happens on one.
 */
export function resetProcessingJobs(): void {
  loaded = true;
  opening.clear();
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* nothing stored is the state being asked for anyway */
  }
  if (ids.length === 0) return;
  ids = [];
  emit();
}

/** The meetings this tab is watching, newest last. */
export function useProcessingJobs(): readonly string[] {
  return useSyncExternalStore(
    subscribe,
    () => {
      load();
      return snapshot;
    },
    // Nothing is tracked during server rendering, and the client's first paint
    // has to agree with it or hydration warns. The store loads on subscribe,
    // which happens after.
    () => EMPTY,
  );
}

const EMPTY: readonly string[] = [];

/** Whether one particular meeting is being watched by this tab. */
export function useIsTracked(meetingId: string): boolean {
  const tracked = useProcessingJobs();
  return tracked.includes(meetingId);
}

/** `untrack`, bound to one id, stable across renders. */
export function useUntrack(meetingId: string): () => void {
  return useCallback(() => untrackProcessing(meetingId), [meetingId]);
}
