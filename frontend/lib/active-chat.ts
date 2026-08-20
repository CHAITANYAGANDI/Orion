"use client";

/**
 * Which thread each chat surface is currently on.
 *
 * ## The behaviour this exists to produce
 *
 * **Opening AI Chat gives you a new chat.** It used to resume whatever you last
 * said: asking the server for history without naming a thread returns the most
 * recent one, so every visit landed mid-conversation from days ago, and a clean
 * sheet was a button press you had to know to look for. Nothing here is
 * persisted, so a page load starts empty and every surface offers a fresh
 * thread.
 *
 * ## Why it is not component state
 *
 * The panel beside the home list and the full AI Chat page are meant to be *the
 * same* conversation — ask in the rail, expand it, and carry on rather than
 * start a second thread that looks identical. Two `useState` calls cannot do
 * that. Today they only appear to, because both default to "the most recent
 * thread" and the server resolves that identically for each; starting fresh
 * removes that coincidence and would leave the expand button abandoning a
 * half-typed conversation.
 *
 * ## Why it is not Redux
 *
 * The store is built by a factory with no default instance, and no test in the
 * app renders a `Provider`. Putting this in `uiSlice` would mean wrapping every
 * chat test in one to assert something that has nothing to do with Redux. This
 * is a single value shared between two components, which is what
 * `useSyncExternalStore` is for.
 *
 * A module variable also has exactly the lifetime wanted: it survives the
 * client-side navigation between the rail and the page, and dies on reload.
 * That is precisely the line between "still talking" and "opening the chat".
 */

import { useCallback, useSyncExternalStore } from "react";

/** Scope -> conversation id. `"workspace"`, or a meeting id. */
const threads = new Map<string, string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** Read the thread a scope is on without subscribing. For event handlers. */
export function activeChat(scope: string): string | null {
  return threads.get(scope) ?? null;
}

/** Remember the thread a scope is on, or forget it when given null. */
export function setActiveChat(scope: string, conversationId: string | null): void {
  if (activeChat(scope) === conversationId) return;
  if (conversationId) {
    threads.set(scope, conversationId);
  } else {
    threads.delete(scope);
  }
  emit();
}

/** Discard every remembered thread. Exists so tests start from a clean sheet. */
export function resetActiveChats(): void {
  if (threads.size === 0) return;
  threads.clear();
  emit();
}

/**
 * The thread this scope is on, and a setter, as a `useState`-shaped pair.
 *
 * Null until something is asked, which is what puts the starter prompts on
 * screen instead of an old conversation.
 */
export function useActiveChat(
  scope: string,
): [string | null, (conversationId: string | null) => void] {
  const conversationId = useSyncExternalStore(
    subscribe,
    () => activeChat(scope),
    // Server-rendered markup has no session, so it renders the empty chat —
    // the same thing the client shows on a first load, which is what keeps
    // the two from disagreeing on hydration.
    () => null,
  );
  const set = useCallback(
    (id: string | null) => setActiveChat(scope, id),
    [scope],
  );
  return [conversationId, set];
}
