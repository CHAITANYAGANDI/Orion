import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  readRecentSearches,
  rememberSearch,
  clearRecentSearches,
  MAX_RECENT,
} from "@/lib/recent-searches";

/**
 * The last few things somebody searched for.
 *
 * <p>Two things are worth holding down. The list is per user, because two
 * accounts on one machine is the ordinary case in development and happens on
 * shared laptops — reading somebody else's searches out of a shared key is a
 * privacy failure that would look like a caching bug.
 *
 * <p>And nothing here may throw. This is user-writable storage in a browser
 * that can refuse to write at all, and none of that is a reason to be unable to
 * search: every failure has to end with the box still working.
 */
const USER = "usr_1";

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("remembering", () => {
  it("keeps the newest first", () => {
    rememberSearch(USER, "stripe");
    rememberSearch(USER, "billing");

    expect(readRecentSearches(USER)).toEqual(["billing", "stripe"]);
  });

  it("moves a repeat up rather than listing it twice", () => {
    rememberSearch(USER, "stripe");
    rememberSearch(USER, "billing");
    rememberSearch(USER, "stripe");

    expect(readRecentSearches(USER)).toEqual(["stripe", "billing"]);
  });

  it("treats a difference of case as the same search", () => {
    rememberSearch(USER, "stripe");
    rememberSearch(USER, "Stripe");

    // Two entries reading "stripe" and "Stripe" look like a bug in the list.
    expect(readRecentSearches(USER)).toEqual(["Stripe"]);
  });

  it("keeps the filters, since they are the search", () => {
    rememberSearch(USER, "tag:q4 budget");

    // Stored as typed. Reduced to "budget" it would come back as a different
    // search from the one that was run.
    expect(readRecentSearches(USER)[0]).toBe("tag:q4 budget");
  });

  it("stores nothing for an empty search", () => {
    rememberSearch(USER, "   ");

    expect(readRecentSearches(USER)).toEqual([]);
  });

  it("stops at a length that still fits on screen", () => {
    for (let i = 0; i < MAX_RECENT + 3; i += 1) rememberSearch(USER, `search ${i}`);

    expect(readRecentSearches(USER)).toHaveLength(MAX_RECENT);
    // The newest survives; the oldest is what falls off.
    expect(readRecentSearches(USER)[0]).toBe(`search ${MAX_RECENT + 2}`);
  });
});

describe("whose list it is", () => {
  it("does not read one account's searches back for another", () => {
    rememberSearch("usr_1", "stripe");
    rememberSearch("usr_2", "payroll");

    expect(readRecentSearches("usr_1")).toEqual(["stripe"]);
    expect(readRecentSearches("usr_2")).toEqual(["payroll"]);
  });

  it("gives a signed-out reader nothing belonging to anyone", () => {
    rememberSearch("usr_1", "stripe");

    expect(readRecentSearches(null)).toEqual([]);
  });
});

describe("forgetting", () => {
  it("clears only the user asked about", () => {
    rememberSearch("usr_1", "stripe");
    rememberSearch("usr_2", "payroll");

    clearRecentSearches("usr_1");

    expect(readRecentSearches("usr_1")).toEqual([]);
    expect(readRecentSearches("usr_2")).toEqual(["payroll"]);
  });
});

describe("storage that will not cooperate", () => {
  it("reads nothing rather than throwing on a hand-edited value", () => {
    window.localStorage.setItem("reverie.recent-searches.usr_1", "{not json");

    expect(readRecentSearches(USER)).toEqual([]);
  });

  it("drops entries that are not strings", () => {
    window.localStorage.setItem(
      "reverie.recent-searches.usr_1",
      JSON.stringify(["stripe", 42, null, "billing"]),
    );

    // The UI maps over this list. One hand-edited entry should not be able to
    // put a number where a search term goes.
    expect(readRecentSearches(USER)).toEqual(["stripe", "billing"]);
  });

  it("lets the search run when writing is refused", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    // Private browsing and a full quota both land here, and neither is a reason
    // to be unable to search.
    expect(() => rememberSearch(USER, "stripe")).not.toThrow();
  });
});
