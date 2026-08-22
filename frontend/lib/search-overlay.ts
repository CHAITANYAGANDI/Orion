"use client";

/**
 * Who has the search box open, and what is in it.
 *
 * The overlay is mounted once, by the shell, and is the only search in the app
 * now that /search is gone. That leaves one thing the shell cannot do on its
 * own: something deep in a page — "Search in folder", on a folder's menu —
 * needs to open it *with a query already typed*. Passing that up through the
 * shell would mean every page that ever wants to hand off to search declaring a
 * prop on the way.
 *
 * So it is a module store, like `lib/active-chat` and `components/side-pane`:
 * `openSearch("in:\"Q4 planning\" ")` from anywhere, and the shell renders it.
 * Nothing is persisted — a search box open across a reload is a page that opens
 * with a dialog nobody asked for.
 */

import * as React from "react";

export interface SearchOverlayState {
  open: boolean;
  /** What the box starts with. Blank for Ctrl-K and the header button. */
  initial: string;
}

const CLOSED: SearchOverlayState = { open: false, initial: "" };

let state: SearchOverlayState = CLOSED;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function set(next: SearchOverlayState): void {
  if (next.open === state.open && next.initial === state.initial) return;
  state = next;
  for (const listener of listeners) listener();
}

/**
 * Open the search box, optionally with something already in it.
 *
 * A trailing space is worth passing on a filter — `in:"Q4 planning" ` — so the
 * cursor lands past it and the next keystroke is the term rather than more of
 * the folder name.
 */
export function openSearch(initial = ""): void {
  set({ open: true, initial });
}

/** Close it, and forget what it was seeded with. */
export function closeSearch(): void {
  set(CLOSED);
}

/** Forget everything. Exists so tests start from a clean sheet. */
export function resetSearchOverlay(): void {
  set(CLOSED);
}

/** The overlay's state, for the shell that draws it. */
export function useSearchOverlay(): SearchOverlayState {
  return React.useSyncExternalStore(
    subscribe,
    () => state,
    // The server renders no overlay, so the first client pass must agree.
    () => CLOSED,
  );
}
