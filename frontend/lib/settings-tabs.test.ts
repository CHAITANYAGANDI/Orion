import { describe, it, expect } from "vitest";
import {
  SETTINGS_TABS,
  DEFAULT_TAB,
  LEGACY_PATHS,
  tabFromPath,
  pathForTab,
} from "@/lib/settings-tabs";

/**
 * Which tab a URL means.
 *
 * A catch-all route has one failure mode worth guarding: a path it does not
 * recognise renders nothing, and a blank pane under a tab bar reads as a page
 * that failed to load rather than as a URL that was mistyped.
 *
 * The other half is the three paths that were pages before they were tabs.
 * `/privacy` in particular is written into notification rows that already exist
 * — those rows are a record of something that happened and their link column
 * cannot be rewritten, so the path has to keep working for as long as they do.
 */

describe("the tabs themselves", () => {
  it("are the six the page offers, in reading order", () => {
    expect(SETTINGS_TABS.map((t) => t.id)).toEqual([
      "general",
      "meetings",
      "plans",
      "integrations",
      "emails",
      "security",
    ]);
  });

  it("does not offer Templates", () => {
    // A summary template is chosen per meeting, so a settings tab listing them
    // was a catalogue beside the one place the choice is never made.
    expect(SETTINGS_TABS.map((t) => t.id)).not.toContain("templates");
    // And the URL that used to open it still lands somewhere rather than blank.
    expect(tabFromPath("/settings/templates")).toBe(DEFAULT_TAB);
  });

  it("open on General and end on Security", () => {
    // Security last on purpose: it holds the irreversible things, and a tab bar
    // is read left to right.
    expect(SETTINGS_TABS[0].id).toBe(DEFAULT_TAB);
    expect(SETTINGS_TABS[SETTINGS_TABS.length - 1].id).toBe("security");
  });
});

describe("reading a path", () => {
  it("takes the bare settings path as General", () => {
    expect(tabFromPath("/settings")).toBe("general");
  });

  it("takes each tab's own path", () => {
    for (const tab of SETTINGS_TABS) {
      expect(tabFromPath(`/settings/${tab.id}`)).toBe(tab.id);
    }
  });

  it("ignores a trailing slash, which a pasted URL often carries", () => {
    expect(tabFromPath("/settings/security/")).toBe("security");
    expect(tabFromPath("/settings/")).toBe("general");
  });

  it("ignores case, since a hand-typed URL will not match ours", () => {
    expect(tabFromPath("/settings/Security")).toBe("security");
  });

  it("falls back to General rather than rendering nothing", () => {
    expect(tabFromPath("/settings/nonsense")).toBe("general");
    expect(tabFromPath("/")).toBe("general");
  });
});

describe("the paths that used to be pages", () => {
  it("still land on the tab that replaced them", () => {
    expect(tabFromPath("/privacy")).toBe("security");
    expect(tabFromPath("/billing")).toBe("plans");
    expect(tabFromPath("/integrations")).toBe("integrations");
  });

  it("keeps /privacy working, because notifications already point at it", () => {
    // RETENTION_APPLIED rows carry this link. Breaking it would break a record
    // of something that already happened.
    expect(LEGACY_PATHS["/privacy"]).toBe("security");
  });

  it("survives a trailing slash on the old form too", () => {
    expect(tabFromPath("/billing/")).toBe("plans");
  });
});

describe("linking to a tab", () => {
  it("produces the canonical path, which reads back as the same tab", () => {
    for (const tab of SETTINGS_TABS) {
      expect(tabFromPath(pathForTab(tab.id))).toBe(tab.id);
    }
  });
});
