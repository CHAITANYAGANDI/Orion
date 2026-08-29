import { describe, it, expect } from "vitest";
import { homeListState, type HomeListInput } from "@/lib/home-list-state";

/**
 * The four states Home can be in, one rule at a time.
 *
 * <h2>Why this file exists rather than only the page test</h2>
 *
 * <p>The bug was `data?.content ?? []` — reading *no answer* as *the answer is
 * none*. Rendering Home cannot reach every combination that produces it: a
 * cached page of undefined with no error and nothing in flight is a real RTK
 * Query state and an awkward one to stage through a component.
 *
 * <p>That gap was measured, not assumed. Mutating the rule to treat
 * `count === null` as empty left all forty-three page tests passing, because
 * every one of them that had no data also had an error, and the error branch
 * caught it first. The bug had a test-shaped hole exactly where it lived.
 *
 * <p>So the decision is a pure function and the matrix is asserted directly.
 */

/** A settled, successful, non-empty response — the ordinary case. */
const OK: HomeListInput = {
  restored: true,
  isUninitialized: false,
  isLoading: false,
  isFetching: false,
  isError: false,
  isSuccess: true,
  count: 3,
};

function state(overrides: Partial<HomeListInput>) {
  return homeListState({ ...OK, ...overrides });
}

describe("homeListState", () => {
  it("shows the list for a settled non-empty response", () => {
    expect(state({})).toBe("list");
  });

  describe("no answer is not an answer of none", () => {
    it("shows the skeleton when there is no cached page and no error", () => {
      // THE bug, in one line. `count: null` means "we do not know"; the old
      // code turned it into `[]`, which means "the server said none".
      expect(
        state({ count: null, isSuccess: false, isLoading: false, isFetching: false }),
      ).toBe("skeleton");
    });

    it("shows the skeleton before anything has been asked", () => {
      expect(state({ isUninitialized: true, count: null, isSuccess: false })).toBe("skeleton");
    });

    it("shows the skeleton while the remembered filters are still being read", () => {
      // `restored` is false before storage has been consulted, and the query is
      // skipped until then -- so every other flag reads as "settled with
      // nothing", which is precisely the trap.
      expect(state({ restored: false, count: null, isSuccess: false })).toBe("skeleton");
    });

    it("shows the skeleton on the first load", () => {
      expect(state({ isLoading: true, isFetching: true, isSuccess: false, count: null })).toBe(
        "skeleton",
      );
    });
  });

  describe("an error is an error", () => {
    it("reports an error when the request failed with nothing cached", () => {
      expect(state({ isError: true, isSuccess: false, count: null })).toBe("error");
    });

    it("reports an error when the request failed over an empty cached page", () => {
      // An empty page is not proof of an empty account when the request that
      // would have confirmed it failed.
      expect(state({ isError: true, isSuccess: false, count: 0 })).toBe("error");
    });

    it("never reports empty for a failed request", () => {
      for (const count of [null, 0]) {
        expect(state({ isError: true, isSuccess: false, count })).not.toBe("empty");
      }
    });
  });

  describe("rows already on screen win", () => {
    it("keeps the list through a background refetch", () => {
      expect(state({ isFetching: true, count: 3 })).toBe("list");
    });

    it("keeps the list when a background refetch fails", () => {
      // Throwing away a good copy because the new one did not arrive is
      // strictly worse than showing the good copy.
      expect(state({ isError: true, isSuccess: false, count: 3 })).toBe("list");
    });

    it("keeps the list even mid-flight with no success flag", () => {
      expect(state({ isFetching: true, isSuccess: false, count: 3 })).toBe("list");
    });
  });

  describe("only a settled, successful, empty response says the account is empty", () => {
    it("allows empty when the server answered with zero", () => {
      expect(state({ count: 0 })).toBe("empty");
    });

    it("withholds empty while a refetch over an empty page is in flight", () => {
      // That cached zero may be about to be replaced by rows.
      expect(state({ count: 0, isFetching: true })).toBe("skeleton");
    });

    it("withholds empty when the response was never successful", () => {
      expect(state({ count: 0, isSuccess: false })).toBe("skeleton");
    });
  });

  it("never says empty for anything but a settled successful zero", () => {
    /*
     * The exhaustive form. Every combination of the flags is enumerated and the
     * empty screen -- the only one that makes a claim about the user's data --
     * must appear for exactly one shape.
     */
    const bools = [true, false];
    for (const restored of bools)
      for (const isUninitialized of bools)
        for (const isLoading of bools)
          for (const isFetching of bools)
            for (const isError of bools)
              for (const isSuccess of bools)
                for (const count of [null, 0, 5]) {
                  const input: HomeListInput = {
                    restored,
                    isUninitialized,
                    isLoading,
                    isFetching,
                    isError,
                    isSuccess,
                    count,
                  };
                  if (homeListState(input) === "empty") {
                    expect(count, JSON.stringify(input)).toBe(0);
                    expect(isSuccess, JSON.stringify(input)).toBe(true);
                    expect(isError, JSON.stringify(input)).toBe(false);
                    expect(isFetching, JSON.stringify(input)).toBe(false);
                    expect(isLoading, JSON.stringify(input)).toBe(false);
                    expect(restored, JSON.stringify(input)).toBe(true);
                    expect(isUninitialized, JSON.stringify(input)).toBe(false);
                  }
                }
  });

  it("never hides rows it has", () => {
    // The mirror of the rule above: if there are rows, nothing may replace them
    // with a skeleton, an error or an empty screen -- except not having asked
    // yet, which is not a state that has rows in practice.
    const bools = [true, false];
    for (const isLoading of bools)
      for (const isFetching of bools)
        for (const isError of bools)
          for (const isSuccess of bools) {
            const result = homeListState({
              restored: true,
              isUninitialized: false,
              isLoading,
              isFetching,
              isError,
              isSuccess,
              count: 5,
            });
            expect(result).toBe("list");
          }
  });
});
