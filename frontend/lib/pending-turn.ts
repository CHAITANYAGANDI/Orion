"use client";

/**
 * The question you just asked, on screen before the server has heard of it —
 * and still there when you come back.
 *
 * ## What was wrong, originally
 *
 * Send emptied the composer, and then the rail showed this:
 *
 *     Searching the transcript…
 *
 * and nothing else. The question was gone from the box and had not arrived
 * anywhere: for the five to ten seconds an answer takes, the only evidence that
 * anything had been asked was a spinner. Then the mutation resolved, the
 * `Chat` tag was invalidated, the history refetched, and the question appeared
 * — above an answer, as though it had always been there.
 *
 * The cause is that the question was only ever *server* state. Nothing in the
 * client held it between `submit()` clearing the input and the refetch bringing
 * it back, so there was nothing to render. Both chats had the bug for the same
 * reason, in two separate copies.
 *
 * ## What was wrong after that
 *
 * The fix held the turn in `useState`, which meant it died with the component.
 * Answers can take a while — a grounded question over a long meeting is a
 * retrieval, a rerank and a generation — and the natural thing to do while
 * waiting is go and look at something else. Doing that unmounted the chat, so
 * the pending turn vanished; coming back showed an empty thread with no sign
 * that anything had been asked. Worse, on a *new* thread the conversation id
 * was only adopted once the answer landed, so leaving before it did meant the
 * surface came back to a clean sheet and the answer was findable only by
 * hunting through the conversation picker.
 *
 * Nothing was lost on the server. The request is not aborted by unmounting, and
 * the exchange is persisted whatever the browser does. It was the interface
 * that forgot.
 *
 * ## So the turn lives in a module store, keyed by scope
 *
 * The same shape as lib/active-chat, and for the same reasons: it outlives a
 * render, it dies on reload, and two surfaces that should not share one cannot
 * accidentally. A scope is `workspace:home`, `workspace:ask`, or `meeting:<id>`.
 *
 * Callers that pass no scope get a per-instance one and the old behaviour
 * exactly — the entry is dropped on unmount. That is what the tests use, and
 * what anything genuinely throwaway should use.
 *
 * ## The rule that prevents a duplicate
 *
 * The turn is cleared when a user message the server did not have at send time
 * appears in the history. Ids are snapshotted on send rather than matching on
 * text, so asking the same question twice still reconciles: the second copy is
 * a different id and is not in that snapshot.
 *
 * It is resolved **during render**, not in an effect. An effect runs after
 * paint, so there would be exactly one frame in which both the persisted
 * message and the pending one were on screen — a flicker in normal use, and a
 * real duplicate to any test that looks straight after the response resolves.
 */

import * as React from "react";
import type { ChatMessage } from "@/lib/types";

export type PendingStatus = "asking" | "failed";

export interface PendingTurn {
  /**
   * Temporary, and deliberately unlike a server id — those are `msg_…`, so a
   * `pending:` prefix cannot be mistaken for one in a React key or a test.
   */
  id: string;
  question: string;
  status: PendingStatus;
}

interface Entry extends PendingTurn {
  /** Which user messages the server had *before* this question was asked. */
  before: ReadonlySet<string>;
}

let counter = 0;

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The question in flight on a scope, or null. Read without subscribing. */
export function pendingTurn(scope: string): PendingTurn | null {
  return entries.get(scope) ?? null;
}

/** Discard every pending turn. Exists so tests start from a clean sheet. */
export function resetPendingTurns(): void {
  if (entries.size === 0) return;
  entries.clear();
  emit();
}

export interface PendingTurnController {
  /** The turn to render, or null. Null the instant the real one arrives. */
  turn: PendingTurn | null;
  /** Call as the request starts, before awaiting anything. */
  begin: (question: string) => void;
  /** Call when the request failed. Keeps the question; stops the spinner. */
  fail: () => void;
  /** Drop it without waiting for reconciliation — e.g. starting a new thread. */
  clear: () => void;
}

/**
 * @param messages the persisted history for the thread currently on screen
 * @param scope    where this turn belongs, so it survives leaving the page.
 *                 Omit for a turn that should die with the component.
 */
export function usePendingTurn(
  messages: ChatMessage[] | undefined,
  scope?: string,
): PendingTurnController {
  // A stable per-instance key for callers with nothing better. `useId` rather
  // than a counter so it is stable across re-renders and unique across
  // concurrent instances.
  const instance = React.useId();
  const key = scope ?? `local:${instance}`;
  const ephemeral = scope === undefined;

  const entry = React.useSyncExternalStore(
    subscribe,
    () => entries.get(key) ?? null,
    // Nothing is pending during server rendering, and the first client paint
    // has to agree with that or hydration warns.
    () => null,
  );

  // An unscoped turn belongs to this component and goes with it. A scoped one
  // is the whole point and must not be cleaned up here — leaving the page is
  // exactly when it has to survive.
  React.useEffect(() => {
    if (!ephemeral) return;
    return () => {
      if (entries.delete(key)) emit();
    };
  }, [ephemeral, key]);

  const arrived = React.useMemo(() => {
    if (!entry || !messages) return false;
    return messages.some((m) => m.role === "user" && !entry.before.has(m.id));
  }, [entry, messages]);

  // The store still holds it for one more render; `arrived` is what the caller
  // sees, so the swap is atomic. This tidies up behind that.
  React.useEffect(() => {
    if (!arrived) return;
    if (entries.delete(key)) emit();
  }, [arrived, key]);

  const begin = React.useCallback(
    (question: string) => {
      counter += 1;
      entries.set(key, {
        id: `pending:${counter}`,
        question,
        status: "asking",
        before: new Set((messages ?? []).map((m) => m.id)),
      });
      emit();
    },
    [key, messages],
  );

  const fail = React.useCallback(() => {
    const current = entries.get(key);
    if (!current) return;
    entries.set(key, { ...current, status: "failed" });
    emit();
  }, [key]);

  const clear = React.useCallback(() => {
    if (entries.delete(key)) emit();
  }, [key]);

  // Memoised because a fresh object every render is a fresh prop identity for
  // every consumer of it, and one of those is a thread that re-scrolls when its
  // contents change. The store entry is stable between writes.
  const turn = React.useMemo(
    () =>
      arrived || !entry
        ? null
        : { id: entry.id, question: entry.question, status: entry.status },
    [arrived, entry],
  );

  return { turn, begin, fail, clear };
}

/**
 * Say that an answer arrived, if the person is no longer where they asked.
 *
 * <p>The request is not aborted by leaving, so the answer lands whatever the
 * browser is showing — but landing silently in a thread nobody is looking at is
 * the same as not landing. This is the notification for exactly that case, and
 * it carries the way back, because a toast that says "your answer is ready"
 * without saying where is a worse version of saying nothing.
 *
 * <p>Silent when the user never left. The answer is on screen; a toast on top
 * of it would fire on every question anybody ever asked.
 *
 * @param askedOn the pathname the question was sent from
 */
export function announceAnswer(askedOn: string): void {
  if (typeof window === "undefined") return;
  if (!askedOn || window.location.pathname === askedOn) return;
  // Imported here rather than at the top: this file is otherwise free of UI
  // dependencies and is used by hooks that tests render without a toaster.
  void import("sonner").then(({ toast }) => {
    toast.success("Your answer is ready.", {
      action: {
        label: "Open",
        onClick: () => {
          window.location.href = askedOn;
        },
      },
    });
  });
}
