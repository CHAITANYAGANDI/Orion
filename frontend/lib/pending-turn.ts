"use client";

/**
 * The question you just asked, on screen before the server has heard of it.
 *
 * ## What was wrong
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
 * ## Why this and not an optimistic cache patch
 *
 * RTK Query can insert a fake turn into the cached history with
 * `updateQueryData`, and for a normal list that is the tidier answer. Not here,
 * because of what a first question does: `useGetChatQuery` is *skipped* until a
 * thread id exists, so on a new chat there is no cache entry to patch — and the
 * id it would be filed under is created by the same click, which means the
 * patch would have to be written into a key that does not exist yet and moved
 * when it does. That is a lot of machinery to make a question visible.
 *
 * A pending turn held next to the query is smaller and says what it means: this
 * is one question, not yet persisted, belonging to whatever thread it lands in.
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

let counter = 0;

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
 */
export function usePendingTurn(messages: ChatMessage[] | undefined): PendingTurnController {
  const [turn, setTurn] = React.useState<PendingTurn | null>(null);
  // Which user messages the server had *before* this question. A ref, not
  // state: writing it must not schedule a render, and it is read in the same
  // tick it is written.
  const before = React.useRef<Set<string>>(new Set());

  const arrived = React.useMemo(() => {
    if (!turn || !messages) return false;
    return messages.some((m) => m.role === "user" && !before.current.has(m.id));
  }, [turn, messages]);

  // The state still holds it for one more render; `arrived` is what the caller
  // sees, so the swap is atomic. This tidies up behind that.
  React.useEffect(() => {
    if (arrived) setTurn(null);
  }, [arrived]);

  const begin = React.useCallback(
    (question: string) => {
      before.current = new Set((messages ?? []).map((m) => m.id));
      counter += 1;
      setTurn({ id: `pending:${counter}`, question, status: "asking" });
    },
    [messages],
  );

  const fail = React.useCallback(() => {
    setTurn((t) => (t ? { ...t, status: "failed" } : t));
  }, []);

  const clear = React.useCallback(() => setTurn(null), []);

  return { turn: arrived ? null : turn, begin, fail, clear };
}
