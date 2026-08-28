"use client";

/**
 * How wide the two panes are, and where that survives to.
 *
 * The shell is three columns — places on the left, the document in the middle,
 * the chat on the right — and until now the outer two were fixed: `w-64` and a
 * `clamp()`. A clamp is a good guess and it is still the starting point here,
 * but it is a guess about somebody else's monitor. Somebody reading a
 * transcript wants the middle wide; somebody working through a long answer
 * wants the chat wide; on a 13-inch laptop both of them want the folder rail
 * out of the way. None of that is knowable from a media query.
 *
 * ## Why the width is in localStorage and not on the server
 *
 * It is a property of the screen, not of the account. Syncing it would push a
 * 34rem chat rail from a desktop onto a laptop where it is half the window,
 * which is the arrangement somebody dragged the divider to get away from.
 *
 * ## The hydration trade
 *
 * Server-rendered markup cannot know what is in localStorage, so the first
 * paint is always the default and the stored width arrives one effect later.
 * The alternative — reading storage during render — is a hydration mismatch,
 * and React resolves those by throwing the server's markup away. A pane that
 * settles into place on load is the cheaper of the two.
 */

import * as React from "react";

/** The limits a pane may be dragged between, and where it starts. */
export interface PaneBounds {
  /** Width before anybody has dragged anything, in pixels. */
  initial: number;
  /** Narrowest useful width. Below this the pane's own content stops fitting. */
  min: number;
  /**
   * Widest allowed. Not a taste judgement: past this the middle column — the
   * meeting, the list, the transcript — stops being the biggest thing on
   * screen, and the middle column is what the other two exist to serve.
   */
  max: number;
}

const PREFIX = "orion.pane.";

/** Hold a width inside its bounds, rounded to whole pixels. */
export function clampWidth(px: number, bounds: { min: number; max: number }): number {
  if (!Number.isFinite(px)) return bounds.min;
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, px)));
}

/**
 * Read a stored width, or null when there is none worth having.
 *
 * Anything unparseable is treated as absent rather than repaired: a corrupt
 * entry is not a width somebody chose, and clamping garbage into range would
 * hand back a number that looks deliberate.
 */
function stored(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const px = Number.parseInt(raw, 10);
    return Number.isFinite(px) ? px : null;
  } catch {
    // Private browsing, a full quota, storage disabled by policy. A pane that
    // cannot remember its width is a pane at its default width, not an error.
    return null;
  }
}

/**
 * A pane's width in pixels, and a setter that remembers it.
 *
 * The bounds are read fresh on every call rather than captured, so a caller may
 * pass an object literal without the setter going stale.
 */
export function usePaneWidth(
  key: string,
  bounds: PaneBounds,
): [number, (px: number) => void] {
  const { initial, min, max } = bounds;
  const [width, setWidth] = React.useState(initial);

  // After hydration, not during render. See the note at the top of the file.
  React.useEffect(() => {
    const saved = stored(key);
    if (saved !== null) setWidth(clampWidth(saved, { min, max }));
  }, [key, min, max]);

  const set = React.useCallback(
    (px: number) => {
      const next = clampWidth(px, { min, max });
      setWidth(next);
      try {
        window.localStorage.setItem(PREFIX + key, String(next));
      } catch {
        // Same as reading: the drag still worked, it just will not outlive
        // the tab. Failing the resize over it would be the worse outcome.
      }
    },
    [key, min, max],
  );

  return [width, set];
}
