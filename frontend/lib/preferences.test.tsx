import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * The React half of a filter that stays where you left it.
 *
 * <p>Three things carry the weight. It must not read storage before auth has
 * said which sign-in this is, or it restores the previous account's choices for
 * a frame. It must report when it *has* read, because the first render can only
 * ever hold the default and a list that fetches on it fetches twice. And a
 * value it cannot make sense of has to become the default rather than anything
 * cleverer — a filter restored from something unreadable narrows a list for a
 * reason nobody can see.
 */
const auth = vi.hoisted(() => ({ sessionKey: "sess_1", isLoaded: true }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ userId: "usr_1", sessionKey: auth.sessionKey, isLoaded: auth.isLoaded }),
}));

import { useStickyPreference, type PreferenceCodec } from "@/lib/preferences";
import { writePreference } from "@/lib/preference-store";

/** Stable across renders, as the hook requires. See PreferenceCodec. */
const TEXT: PreferenceCodec<string> = {
  save: (value) => value,
  load: (raw) => (typeof raw === "string" ? raw : null),
};

beforeEach(() => {
  window.localStorage.clear();
  auth.sessionKey = "sess_1";
  auth.isLoaded = true;
});

describe("useStickyPreference", () => {
  it("opens on the default when nothing was remembered", () => {
    const { result } = renderHook(() => useStickyPreference("k", "recent", TEXT));
    expect(result.current.value).toBe("recent");
    expect(result.current.ready).toBe(true);
  });

  it("puts back what was chosen last time", () => {
    writePreference("sess_1", "k", "all");
    const { result } = renderHook(() => useStickyPreference("k", "recent", TEXT));
    expect(result.current.value).toBe("all");
  });

  it("remembers a choice across a remount", () => {
    const first = renderHook(() => useStickyPreference("k", "recent", TEXT));
    act(() => first.result.current.set("all"));
    expect(first.result.current.value).toBe("all");
    first.unmount();

    // Leaving the page and coming back is the whole point: this used to be the
    // moment the filter was lost.
    const second = renderHook(() => useStickyPreference("k", "recent", TEXT));
    expect(second.result.current.value).toBe("all");
  });

  it("remembers a deliberate return to the default", () => {
    writePreference("sess_1", "k", "all");
    const first = renderHook(() => useStickyPreference("k", "recent", TEXT));
    act(() => first.result.current.set("recent"));
    first.unmount();

    // Choosing the default is a choice. Treating it as "no opinion" would
    // reinstate the old filter on the next visit, which is the same bug the
    // other way round.
    const second = renderHook(() => useStickyPreference("k", "recent", TEXT));
    expect(second.result.current.value).toBe("recent");
  });

  it("goes back to the default under a new sign-in", () => {
    writePreference("sess_1", "k", "all");

    auth.sessionKey = "sess_2";
    const { result } = renderHook(() => useStickyPreference("k", "recent", TEXT));

    // Signing out and back in is a new session, and this is what the whole
    // arrangement exists for.
    expect(result.current.value).toBe("recent");
  });

  it("reads nothing until auth has said which sign-in this is", () => {
    writePreference("sess_1", "k", "all");
    auth.isLoaded = false;

    const { result, rerender } = renderHook(() => useStickyPreference("k", "recent", TEXT));
    // Not merely the default -- not ready, so nothing downstream acts on it.
    expect(result.current.value).toBe("recent");
    expect(result.current.ready).toBe(false);

    auth.isLoaded = true;
    rerender();
    expect(result.current.ready).toBe(true);
    expect(result.current.value).toBe("all");
  });

  it("falls back to the default when what was stored makes no sense", () => {
    // An older build's format, or something edited by hand.
    writePreference("sess_1", "k", { unexpected: true });
    const { result } = renderHook(() => useStickyPreference("k", "recent", TEXT));
    expect(result.current.value).toBe("recent");
    expect(result.current.ready).toBe(true);
  });

  it("keeps two preferences apart", () => {
    const scope = renderHook(() => useStickyPreference("scope", "recent", TEXT));
    const when = renderHook(() => useStickyPreference("when", "any", TEXT));
    act(() => scope.result.current.set("all"));

    expect(when.result.current.value).toBe("any");
    scope.unmount();
    when.unmount();

    const again = renderHook(() => useStickyPreference("when", "any", TEXT));
    expect(again.result.current.value).toBe("any");
  });

  /* -------------------------------------------------------------------------
   * A value belongs to the sign-in it was read under
   * ---------------------------------------------------------------------- */

  it("never reports the previous session's value as ready, in any render", () => {
    /*
     * THE bug behind Home opening on "Recent Conversations" for somebody who
     * had never chosen it.
     *
     * `ready` and `value` used to be plain state, written by the effect below
     * and describing whichever sign-in that effect last ran for. React renders
     * before it runs effects, so there was a render in which `sessionKey` was
     * already the new session and `ready` was still `true` carrying the
     * previous one's value -- and a caller that waits for `ready` before
     * querying, which is the entire purpose of `ready`, queried with it.
     *
     * On Home that first request went out with `unfiled=true`, and an account
     * that files everything has no unfiled meetings: "Everything is in a
     * folder", over a full archive.
     *
     * Asserted over every render rather than at the end, because the bad state
     * lasted exactly one render and then corrected itself -- which is precisely
     * why it was hard to see and easy to fire a request from.
     */
    const seen: Array<{ session: string; ready: boolean; value: string }> = [];
    writePreference("sess_1", "k", "all");

    const { rerender } = renderHook(() => {
      const pref = useStickyPreference("k", "recent", TEXT);
      seen.push({ session: auth.sessionKey, ready: pref.ready, value: pref.value });
      return pref;
    });

    auth.sessionKey = "sess_2";
    rerender();

    const wrong = seen.filter((r) => r.session === "sess_2" && r.ready && r.value === "all");
    expect(wrong, JSON.stringify(seen)).toEqual([]);

    // And not merely un-ready: the previous session's value must not be handed
    // out at all. A caller that reads `value` without checking `ready` -- and
    // there is nothing stopping one -- would otherwise get "all" for a session
    // that never chose it.
    const leaked = seen.filter((r) => r.session === "sess_2" && r.value === "all");
    expect(leaked, JSON.stringify(seen)).toEqual([]);
  });

  it("starts a new session on the default rather than the previous choice", () => {
    writePreference("sess_1", "k", "all");
    const { result, rerender } = renderHook(() => useStickyPreference("k", "recent", TEXT));
    expect(result.current.value).toBe("all");

    auth.sessionKey = "sess_2";
    act(() => rerender());

    // Settled, and back to the default: `sess_2` has stored nothing.
    expect(result.current.ready).toBe(true);
    expect(result.current.value).toBe("recent");
  });

  it("restores a stored choice that genuinely belongs to the new session", () => {
    writePreference("sess_2", "k", "all");
    auth.sessionKey = "sess_2";

    const { result } = renderHook(() => useStickyPreference("k", "recent", TEXT));

    expect(result.current.ready).toBe(true);
    expect(result.current.value).toBe("all");
  });

  it("keeps an explicit choice sticky within one session", () => {
    const { result, rerender } = renderHook(() => useStickyPreference("k", "recent", TEXT));
    act(() => result.current.set("all"));

    rerender();
    rerender();

    expect(result.current.value).toBe("all");
    expect(result.current.ready).toBe(true);
  });

  it("is never ready before auth knows which sign-in this is", () => {
    // `sessionKey` is "" for want of an answer here, not because nobody is
    // signed in -- so there is no sign-in to be ready *for*.
    auth.isLoaded = false;
    auth.sessionKey = "";

    const { result } = renderHook(() => useStickyPreference("k", "recent", TEXT));

    expect(result.current.ready).toBe(false);
    expect(result.current.value).toBe("recent");
  });
});
