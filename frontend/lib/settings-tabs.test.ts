import { describe, it, expect } from "vitest";
import {
  SETTINGS_TABS,
  DEFAULT_TAB,
  LEGACY_PATHS,
  tabFromPath,
  pathForTab,
  isSettingsPath,
} from "@/lib/settings-tabs";

/**
 * Which tab a URL means.
 *
 * A catch-all route has one failure mode worth guarding: a path it does not
 * recognise renders nothing, and a blank pane under a tab bar reads as a page
 * that failed to load rather than as a URL that was mistyped.
 *
 * The other half is the two paths that were pages before they were tabs.
 * `/privacy` in particular is written into notification rows that already exist
 * — those rows are a record of something that happened and their link column
 * cannot be rewritten, so the path has to keep working for as long as they do.
 */

describe("the tabs themselves", () => {
  it("are the two the page offers, in reading order", () => {
    expect(SETTINGS_TABS.map((t) => t.id)).toEqual(["general", "plans"]);
  });

  it("offers none of the four that were removed", () => {
    // Each went with the thing it configured: Integrations with the calendar
    // feed, Meetings with sharing (its other two sections moved to General),
    // and Emails and Security with the settings they held. A tab that opens
    // onto nothing is worse than no tab.
    const ids = SETTINGS_TABS.map((t) => t.id);
    for (const gone of ["integrations", "meetings", "emails", "security"]) {
      expect(ids).not.toContain(gone);
    }
  });

  it("does not offer Templates", () => {
    // A summary template is chosen per meeting, so a settings tab listing them
    // was a catalogue beside the one place the choice is never made.
    expect(SETTINGS_TABS.map((t) => t.id)).not.toContain("templates");
    // And the URL that used to open it still lands somewhere rather than blank.
    expect(tabFromPath("/settings/templates")).toBe(DEFAULT_TAB);
  });

  it("open on General, which is where somebody lands", () => {
    expect(SETTINGS_TABS[0].id).toBe(DEFAULT_TAB);
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
    expect(tabFromPath("/settings/plans/")).toBe("plans");
    expect(tabFromPath("/settings/")).toBe("general");
  });

  it("ignores case, since a hand-typed URL will not match ours", () => {
    expect(tabFromPath("/settings/Plans")).toBe("plans");
  });

  it("falls back to General rather than rendering nothing", () => {
    expect(tabFromPath("/settings/nonsense")).toBe("general");
    expect(tabFromPath("/")).toBe("general");
  });
});

describe("the paths that used to be pages", () => {
  it("still land somewhere rather than nowhere", () => {
    expect(tabFromPath("/billing")).toBe("plans");
    // Security is gone, so this lands on General. It has to keep resolving:
    // RETENTION_APPLIED notification rows carry /privacy in their link column,
    // and those rows are a record of something that already happened.
    expect(tabFromPath("/privacy")).toBe("general");
    expect(LEGACY_PATHS["/privacy"]).toBe("general");
  });

  it("sends every removed tab's URL to General rather than to a blank pane", () => {
    for (const gone of ["integrations", "meetings", "emails", "security"]) {
      expect(tabFromPath(`/settings/${gone}`)).toBe("general");
    }
    expect(tabFromPath("/integrations")).toBe("general");
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

/**
 * Whether the shell should drop the search bar.
 *
 * <p>The failure this guards against is invisible on the page it happens on:
 * arriving at the Plans tab through `/billing` and seeing a search bar that is
 * absent when you arrive at the same screen through `/settings/plans`. Nobody
 * would report it, and it would look like the bar flickering at random.
 *
 * <p>The other half is the opposite mistake — a `startsWith("/settings")` that
 * also swallows a future `/settingsomething`, or an `in` check that says yes to
 * `/toString`.
 */
describe("where the search bar is hidden", () => {
  it("covers Account Settings and every tab of it", () => {
    expect(isSettingsPath("/settings")).toBe(true);
    for (const tab of SETTINGS_TABS) {
      expect(isSettingsPath(pathForTab(tab.id))).toBe(true);
    }
  });

  it("covers the old URLs, which are the same page", () => {
    for (const path of Object.keys(LEGACY_PATHS)) {
      expect(isSettingsPath(path)).toBe(true);
    }
  });

  it("is not fooled by a trailing slash", () => {
    expect(isSettingsPath("/settings/")).toBe(true);
    expect(isSettingsPath("/privacy/")).toBe(true);
    expect(isSettingsPath("/billing/")).toBe(true);
  });

  it("leaves the search bar on every page that has meetings behind it", () => {
    for (const path of ["/home", "/ask", "/meetings/mtg_1", "/folders", "/record"]) {
      expect(isSettingsPath(path)).toBe(false);
    }
  });

  it("does not match a path that merely starts with the same letters", () => {
    expect(isSettingsPath("/settingsomething")).toBe(false);
  });

  it("does not match an inherited property name", () => {
    // `"/toString" in LEGACY_PATHS` is false, but `"toString" in` anything is
    // true — the kind of thing a plain `in` check gets wrong once.
    expect(isSettingsPath("/toString")).toBe(false);
    expect(isSettingsPath("/constructor")).toBe(false);
  });
});
