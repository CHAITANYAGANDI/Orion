import { describe, it, expect } from "vitest";

import { headerChrome } from "@/lib/chrome";
import { SETTINGS_TABS, LEGACY_PATHS, pathForTab } from "@/lib/settings-tabs";

/**
 * What the top bar carries, page by page.
 *
 * <p>Both rules here fail the same quiet way: a control that should be absent
 * is present on one route and gone on another that renders the identical
 * screen. Nobody reports that — it reads as the header flickering at random —
 * so the tests below walk every URL each page answers to rather than one
 * representative of each.
 *
 * <p>The third group is the one that matters most. Whatever else is hidden,
 * the header must never be stripped of everything on a page somebody works on,
 * and the live recording indicator is never part of this decision at all.
 */

/** Pages that are neither settings nor the chat, so nothing is hidden. */
const WORKING_PAGES = [
  "/home",
  "/meetings/mtg_1",
  "/projects",
  "/projects/prj_1",
  "/action-items",
  "/search",
  "/record",
  "/upload",
];

describe("search in the header", () => {
  it("is gone on Account Settings, under every URL it answers to", () => {
    expect(headerChrome("/settings").search).toBe(false);
    for (const tab of SETTINGS_TABS) {
      expect(headerChrome(pathForTab(tab.id)).search).toBe(false);
    }
    // The old page URLs render the identical component. Hiding the bar on one
    // and not the other would depend on which link somebody followed.
    for (const path of Object.keys(LEGACY_PATHS)) {
      expect(headerChrome(path).search).toBe(false);
    }
  });

  it("stays on the chat", () => {
    // Asking a question and finding the meeting the answer came from are the
    // same activity, so this is the one control worth keeping here.
    expect(headerChrome("/ask").search).toBe(true);
  });

  it("stays everywhere there are meetings to find", () => {
    for (const path of WORKING_PAGES) {
      expect(headerChrome(path).search).toBe(true);
    }
  });
});

describe("Import and Record", () => {
  it("are gone on the chat", () => {
    expect(headerChrome("/ask").create).toBe(false);
  });

  it("are gone on a chat with an id, if there is ever one", () => {
    // A string compare at the call site would drop this rule the day the route
    // grows a segment, and the button would come back without anyone deciding.
    expect(headerChrome("/ask/thr_1").create).toBe(false);
  });

  it("do not disappear on a path that merely starts with the same letters", () => {
    expect(headerChrome("/asking").create).toBe(true);
  });

  it("stay on Account Settings", () => {
    // Nothing about settings makes recording a call the wrong thing to do next.
    expect(headerChrome("/settings/emails").create).toBe(true);
  });

  it("stay everywhere else", () => {
    for (const path of WORKING_PAGES) {
      expect(headerChrome(path).create).toBe(true);
    }
  });
});

describe("the header is never empty on a working page", () => {
  it("keeps at least one control on every page that is not settings or chat", () => {
    for (const path of WORKING_PAGES) {
      const chrome = headerChrome(path);
      expect(chrome.search || chrome.create).toBe(true);
    }
  });

  it("never hides both, on any page", () => {
    for (const path of ["/settings", "/ask", "/integrations", "/billing", ...WORKING_PAGES]) {
      const chrome = headerChrome(path);
      expect(chrome.search || chrome.create).toBe(true);
    }
  });
});
