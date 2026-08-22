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
 * **A thread belongs to one surface.** Home and the full AI Chat page are keyed
 * separately (`workspace:home`, `workspace:ask`) even though they read the same
 * meetings through the same endpoints, because they are two screens and a
 * question asked on one has no business appearing on the other. They briefly
 * shared a key, from when Home's expand button navigated to /ask and the two
 * had to be one conversation; expanding widens the rail in place now.
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
     * **Nothing asks for this today**, and the reason it is still here is that
     * it is one word away from being wanted again.
     *
     * The workspace chat used to. Home and the full AI Chat page shared a
     * single scope key, so the only way to stop one adopting the other's
     * conversation was for the thread to be forgotten whenever either of them
     * unmounted. That cost more than it bought: it also meant a trip to a
     * meeting and back lost what you had been asking on Home. The two surfaces
     * are keyed apart now — `workspace:home` and `workspace:ask` — which
     * separates them precisely rather than by clearing everything.
     *
     * Turn it back on for a surface that genuinely should open blank every
     * time. Note the deliberate lack of reference counting: if two surfaces of
     * one scope overlap for a frame during a navigation, counting would
     * *preserve* the thread across exactly the move this exists to reset.
     * Clearing on any unmount errs towards the new chat.
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
