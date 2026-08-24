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
  const [value, setValue] = React.useState<T>(fallback);
  const [ready, setReady] = React.useState(false);

  // `fallback` is deliberately not a dependency: callers pass object literals
  // (ANY_TIME is one), and depending on it would re-read storage on every
  // render and throw away whatever was just chosen. It is only ever read at the
  // moment nothing was restored, so a stale one cannot be wrong.
  const initial = React.useRef(fallback);

  React.useEffect(() => {
    // Until auth has loaded there is no sign-in to read under, and reading
    // under the wrong one would restore the previous account's choices for a
    // frame.
    if (!isLoaded) return;
    const stored = readPreferences(sessionKey)[name];
    const restored = stored === undefined ? null : codec.load(stored);
    setValue(restored ?? initial.current);
    setReady(true);
  }, [isLoaded, sessionKey, name, codec]);

  const set = React.useCallback(
    (next: T) => {
      setValue(next);
      // Including a return to the default. "Any time" chosen deliberately is a
      // choice, and coming back to find last week's filter reinstated because
      // the default was treated as "no opinion" is the same bug in reverse.
      writePreference(sessionKey, name, codec.save(next));
    },
    [sessionKey, name, codec],
  );

  return { value, set, ready };
}
