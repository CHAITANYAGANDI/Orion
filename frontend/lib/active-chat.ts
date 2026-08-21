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
 * **Leaving the page gives you a new one too.** Opening Account Settings and
 * coming back to Home used to return you to the conversation you had before,
 * because the thread survived the navigation. That was deliberate and it was
 * wrong: at the time, the home rail's expand button *navigated* to /ask, so
 * losing the thread there would have meant the expand control abandoning a
 * half-typed question. Expanding is done in place now — see
 * components/side-pane.tsx — and nothing else needs a thread to outlive a
 * navigation. So a scope can ask to be forgotten when its surface leaves.
 *
 * A meeting's chat deliberately does not. Coming back to a meeting is coming
 * back to one document, and what you were asking about it is part of reading
 * it; there is no equivalent of "I have gone somewhere else and I am starting
 * over".
 *
 * ## Why it is not component state
 *
 * The panel beside the home list and the full AI Chat page must not each keep
 * their own idea of which thread is open — two `useState` calls in two trees
 * would drift, and only appear not to because both default to "the most recent
 * thread" and the server resolves that identically for each.
 *
 * ## Why it is not Redux
 *
 * The store is built by a factory with no default instance, and no test in the
 * app renders a `Provider`. Putting this in `uiSlice` would mean wrapping every
 * chat test in one to assert something that has nothing to do with Redux. This
 * is a single value shared between two components, which is what
 * `useSyncExternalStore` is for.
 *
 * A module variable also has exactly the lifetime wanted: it outlives a render
 * and dies on reload, and what it does in between is the caller's choice.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";

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
  options?: {
    /**
     * Forget the thread when this surface leaves the page.
     *
     * The workspace chat asks for it, so that going to Settings and coming
     * back to Home is a clean sheet rather than yesterday's questions. A
     * meeting's chat does not — see the note at the top of the file.
     *
     * Deliberately not reference-counted, unlike the side pane's occupancy.
     * If two surfaces of the same chat ever overlap for a frame during a
     * navigation, counting would *preserve* the thread across exactly the
     * move this exists to reset — going from the home rail to the full chat
     * page. Clearing on any unmount errs towards the new chat, which is the
     * behaviour being asked for either way.
     */
    resetOnLeave?: boolean;
  },
): [string | null, (conversationId: string | null) => void] {
  const resetOnLeave = options?.resetOnLeave ?? false;

  useEffect(() => {
    if (!resetOnLeave) return;
    return () => setActiveChat(scope, null);
  }, [scope, resetOnLeave]);

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
