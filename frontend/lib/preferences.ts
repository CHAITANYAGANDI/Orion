"use client";

/**
 * A control that stays where you left it, until you sign out.
 *
 * <p>The storage rules — and why signing out has to reset them — are in
 * lib/preference-store.ts. This is the React half: which sign-in is current,
 * when it is safe to read, and how a stored value becomes a live one.
 */

import * as React from "react";
import { useAuth } from "@/lib/auth";
import { readPreferences, writePreference } from "@/lib/preference-store";

/**
 * How a preference survives the trip to disk and back.
 *
 * <p>`save` exists because what is worth storing is often not the value in
 * hand. A date window is two absolute instants; storing those would freeze
 * "Last 7 days" to the week it was picked. `save` reduces it to the choice, and
 * `load` rebuilds a window from that against today's clock.
 *
 * <p>`load` is also the validator, and the only one. What comes back is
 * whatever was in storage — written by an older build, edited by hand, or
 * corrupt — so it arrives as `unknown` and returns null for anything it does
 * not fully recognise.
 *
 * <p>Both must be stable across renders: they are effect dependencies, so an
 * inline arrow would re-read storage on every render and undo the value that
 * was just set. Define them at module scope.
 */
export interface PreferenceCodec<T> {
  save: (value: T) => unknown;
  load: (raw: unknown) => T | null;
}

export interface StickyPreference<T> {
  value: T;
  set: (next: T) => void;
  /**
   * Whether storage has been consulted yet.
   *
   * <p>Worth waiting for rather than ignoring. Storage cannot be read while
   * rendering — it does not exist on the server, and reading it during the
   * first client render is the classic hydration mismatch — so the first render
   * necessarily has the default. A list that fetches on that render fetches
   * twice and visibly re-sorts itself; one that waits shows the skeleton it was
   * going to show anyway, for one tick longer.
   */
  ready: boolean;
}

export function useStickyPreference<T>(
  name: string,
  fallback: T,
  codec: PreferenceCodec<T>,
): StickyPreference<T> {
  const { sessionKey, isLoaded } = useAuth();

  /**
   * What was restored, and <b>which sign-in it was restored under</b>.
   *
   * <h3>The bug</h3>
   *
   * <p>This used to be two pieces of state — a `value` and a `ready` boolean —
   * both written by the effect below. Neither of them said which session they
   * belonged to, so when `sessionKey` changed they went on describing the
   * previous one until the effect got round to running.
   *
   * <p>React renders before it runs effects. So there is a render in which
   * `sessionKey` is already the new session and `ready` is still `true`
   * carrying the old session's value — and a caller that waits for `ready`
   * before querying, which is the whole point of `ready`, queries with it.
   *
   * <p>On Home that is exactly the reported failure. The previous sign-in had
   * chosen "Recent Conversations", which is `unfiled=true` on the wire, so the
   * first request of the new session asked for meetings that were never filed
   * into a folder — and an account that files everything has none, giving
   * "Everything is in a folder" over a full archive. The default for a new
   * session is All Conversations, and it was never consulted.
   *
   * <p>Storing the session alongside the value makes the answer derived rather
   * than remembered: it stops being ready in the <em>same render</em> the
   * session changes, with no window at all.
   */
  const [restored, setRestored] = React.useState<{ session: string; value: T } | null>(null);

  // `fallback` is deliberately not a dependency: callers pass object literals
  // (ANY_TIME is one), and depending on it would re-read storage on every
  // render and throw away whatever was just chosen. It is only ever read at the
  // moment nothing was restored, so a stale one cannot be wrong.
  const initial = React.useRef(fallback);

  React.useEffect(() => {
    // Until auth has loaded there is no sign-in to read under, and reading
    // under the wrong one would restore the previous account's choices.
    if (!isLoaded || !sessionKey) return;
    const stored = readPreferences(sessionKey)[name];
    const loaded = stored === undefined ? null : codec.load(stored);
    setRestored({ session: sessionKey, value: loaded ?? initial.current });
  }, [isLoaded, sessionKey, name, codec]);

  /*
   * Derived, every render. A value belonging to a different sign-in is not a
   * value this sign-in has, and it is not "ready" — it is nothing, and the
   * caller gets the default until storage has actually been read for the
   * session it is now in.
   */
  const owned = isLoaded && Boolean(sessionKey) && restored?.session === sessionKey;
  const value = owned ? (restored as { value: T }).value : initial.current;

  const set = React.useCallback(
    (next: T) => {
      setRestored({ session: sessionKey, value: next });
      // Including a return to the default. "Any time" chosen deliberately is a
      // choice, and coming back to find last week's filter reinstated because
      // the default was treated as "no opinion" is the same bug in reverse.
      writePreference(sessionKey, name, codec.save(next));
    },
    [sessionKey, name, codec],
  );

  return { value, set, ready: owned };
}
