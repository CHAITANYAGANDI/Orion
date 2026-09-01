"use client";

/**
 * The third column, and how a page fills it.
 *
 * The AI chat used to be an `<aside>` inside whichever page drew it, which made
 * it a piece of that page's content: it began below the top bar, it ended where
 * the page's padding ended, and the header's buttons ran across the top of it
 * because the header spans the window and the rail did not. Home worked around
 * that with a margin on the header that restated the rail's own `clamp()` in a
 * second file, and the meeting page worked around it with a third copy of the
 * same numbers.
 *
 * It is now a pane of the shell, like the folder rail on the left: full height,
 * against the edge, with the middle column ending where it begins. Nothing has
 * to be cleared past it because nothing overlaps it.
 *
 * ## Why a portal, rather than the shell rendering the chat
 *
 * The shell knows the pathname and nothing else. The meeting rail needs the
 * meeting, its summary sections, its suggestions, the seek handler that drives
 * the player, and which tab is open; the home rail needs the workspace chat and
 * the action items. Hoisting any of that into the shell means either drilling a
 * page's whole world through it or fetching it twice.
 *
 * So the page keeps the component, its state and its queries exactly where they
 * are, and only the rendered output moves. Same trade as
 * components/header-slot.tsx, for the same reason.
 *
 * ## Why occupancy is a store and not `pathname === "/home"`
 *
 * Because it is not true of a path. A meeting has a rail once it is READY and
 * none while it is processing, and the pane must take no width at all in the
 * second case — a 28rem strip of empty card beside a progress bar is worse than
 * no pane. The page mounting a `SidePane` is the only thing that knows.
 */

import * as React from "react";
import { createPortal } from "react-dom";

/** The id of the element in the shell that receives the pane's content. */
export const SIDE_PANE_ID = "reverie-side-pane";

/** What the shell needs to know to draw the pane. */
export interface SidePaneState {
  /** Whether a page has put anything in it. */
  occupied: boolean;
  /**
   * Whether the reader wants to see it.
   *
   * Not persisted, unlike the width. A width is a fact about the monitor and is
   * worth remembering; a collapse is usually "get this out of the way for a
   * minute", and coming back tomorrow to an app with no chat in it — and one
   * icon to explain where it went — is the wrong thing to remember.
   */
  open: boolean;
  /**
   * Whether it has been maximised over the page.
   *
   * A rail is a good width for asking and a poor one for reading a long answer
   * back, and a meeting's chat has nowhere bigger to go: the home rail expands
   * by opening /ask, and there is no equivalent page for one meeting. So it
   * expands in place, over the document rather than instead of it, and the same
   * control puts it back.
   */
  expanded: boolean;
}

const CLOSED: SidePaneState = { occupied: false, open: true, expanded: false };

let state: SidePaneState = CLOSED;
let occupants = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function set(next: SidePaneState): void {
  if (
    next.occupied === state.occupied &&
    next.open === state.open &&
    next.expanded === state.expanded
  ) {
    return;
  }
  state = next;
  for (const listener of listeners) listener();
}

/**
 * Claim the pane until the returned function is called.
 *
 * Counted rather than a flag: React mounts the next page's tree before
 * unmounting the last one's during a transition, so two `SidePane`s overlap for
 * a frame, and a boolean would be switched off by the one that left.
 */
export function occupySidePane(): () => void {
  occupants += 1;
  set({ ...state, occupied: true });
  return () => {
    occupants = Math.max(0, occupants - 1);
    const occupied = occupants > 0;
    // Maximised is a state of one page's rail, and the control that undoes it
    // lives inside that rail. Carrying it across a navigation would maximise a
    // panel with no way to shrink itself again.
    set({ ...state, occupied, expanded: occupied && state.expanded });
  };
}

/** Show or hide the pane. */
export function toggleSidePane(): void {
  set({ ...state, open: !state.open });
}

/** Maximise the pane over the page, or put it back to a column. */
export function toggleSidePaneExpanded(): void {
  set({ ...state, expanded: !state.expanded });
}

/** Forget everything. Exists so tests start from a clean sheet. */
export function resetSidePane(): void {
  occupants = 0;
  set(CLOSED);
}

/** The pane's state, for the shell and for anything that offers to hide it. */
export function useSidePane(): SidePaneState {
  return React.useSyncExternalStore(
    subscribe,
    () => state,
    // The server renders no page's rail, so it renders no pane. The client
    // agrees on the first pass and fills it an effect later.
    () => CLOSED,
  );
}

/**
 * Put this page's rail in the shell's right-hand pane.
 *
 * Renders nothing on the server and nothing on the first client pass, because
 * the target does not exist until the shell has mounted. One frame late is
 * invisible for a panel and is the price of not making the shell import every
 * page's data.
 */
export function SidePane({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    setTarget(document.getElementById(SIDE_PANE_ID));
  }, []);

  // Only once there is somewhere to render. Claiming the pane while rendering
  // nothing into it would open an empty column.
  React.useEffect(() => {
    if (!target) return;
    return occupySidePane();
  }, [target]);

  if (!target) return null;
  return createPortal(children, target);
}
