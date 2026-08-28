import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readPreferences, writePreference, clearPreferences } from "@/lib/preference-store";

/**
 * Filters that outlive the page and not the sign-in.
 *
 * <p>The first half is a convenience. The second is the requirement, and it is
 * the one worth testing: signing out has to put the filters back to their
 * defaults, and it has to do so even when nobody thought to call anything.
 * There are two mechanisms for that here and both are pinned below, because
 * each covers a case the other does not — the stamp survives a session nobody
 * ended cleanly, the explicit clear survives a sign-in that reuses the stamp.
 */

beforeEach(() => {
  window.localStorage.clear();
});

describe("remembering", () => {
  it("reads back what was written under the same sign-in", () => {
    writePreference("sess_1", "home.scope", "all");
    expect(readPreferences("sess_1")["home.scope"]).toBe("all");
  });

  it("keeps several choices side by side", () => {
    writePreference("sess_1", "home.scope", "all");
    writePreference("sess_1", "home.when", { kind: "preset", key: "week" });

    const values = readPreferences("sess_1");
    expect(values["home.scope"]).toBe("all");
    expect(values["home.when"]).toEqual({ kind: "preset", key: "week" });
  });

  it("replaces a choice rather than accumulating them", () => {
    writePreference("sess_1", "home.scope", "all");
    writePreference("sess_1", "home.scope", "recent");
    expect(readPreferences("sess_1")["home.scope"]).toBe("recent");
  });

  it("forgets a choice written as null", () => {
    writePreference("sess_1", "home.when", { kind: "preset", key: "week" });
    writePreference("sess_1", "home.when", null);
    expect(readPreferences("sess_1")["home.when"]).toBeUndefined();
  });
});

describe("signing out", () => {
  it("hands back nothing under a different sign-in", () => {
    writePreference("sess_1", "home.scope", "all");

    // The same person signing in again is a new session, which is exactly the
    // case this covers -- and it covers it whether or not anything ran on the
    // way out.
    expect(readPreferences("sess_2")).toEqual({});
  });

  it("forgets everything when told to", () => {
    writePreference("sess_1", "home.scope", "all");
    writePreference("sess_1", "home.when", { kind: "preset", key: "today" });

    clearPreferences();

    // Not just ignored under a new stamp -- gone. Dev mode signs back in under
    // the same id, so the stamp alone would not notice, and one account's
    // choices are not left on disk for whoever signs in next.
    expect(readPreferences("sess_1")).toEqual({});
    expect(window.localStorage.getItem("orion.prefs")).toBeNull();
  });

  it("starts a fresh record rather than merging into the old one", () => {
    writePreference("sess_1", "home.scope", "all");
    writePreference("sess_2", "home.when", { kind: "preset", key: "today" });

    // The new sign-in must not inherit the previous one's scope through the
    // side door of a shared record.
    const values = readPreferences("sess_2");
    expect(values["home.scope"]).toBeUndefined();
    expect(values["home.when"]).toEqual({ kind: "preset", key: "today" });
  });

  it("does not throw away a signed-in tab's choices just by being read", () => {
    writePreference("sess_1", "home.scope", "all");

    // A read under the wrong stamp -- another tab mid-sign-out, or this one
    // before auth has loaded -- answers "nothing" without destroying anything.
    readPreferences("sess_2");
    readPreferences("");

    expect(readPreferences("sess_1")["home.scope"]).toBe("all");
  });

  it("has nothing to say before there is a sign-in to say it under", () => {
    writePreference("sess_1", "home.scope", "all");
    expect(readPreferences("")).toEqual({});

    // And writing without one is dropped rather than filed under the empty
    // string, where the next reader would be whoever asked first.
    writePreference("", "home.scope", "recent");
    expect(readPreferences("sess_1")["home.scope"]).toBe("all");
  });
});

describe("when storage misbehaves", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats an unreadable record as nothing remembered", () => {
    window.localStorage.setItem("orion.prefs", "{ not json");
    expect(readPreferences("sess_1")).toEqual({});
  });

  it("ignores a record of the wrong shape", () => {
    window.localStorage.setItem("orion.prefs", JSON.stringify({ session: 7 }));
    expect(readPreferences("sess_1")).toEqual({});
  });

  it("survives a browser that refuses to store anything", () => {
    // Private windows and disabled site data both throw here. A filter that
    // stops being remembered is a smaller problem than a page that will not
    // render, so nothing may escape.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => writePreference("sess_1", "home.scope", "all")).not.toThrow();

    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readPreferences("sess_1")).toEqual({});

    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => clearPreferences()).not.toThrow();
  });
});
