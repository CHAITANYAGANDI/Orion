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
});
