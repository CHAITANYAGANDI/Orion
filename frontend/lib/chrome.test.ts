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
 * <p>The last group pins which pages end up with a stripped header at all.
 * Account Settings is the one that ends up with nothing, and an empty bar reads
 * as a rendering failure rather than a decision — so it is written down here
 * before somebody tries to fix it. The live recording indicator is never part
 * of this decision on any page.
 */

/** Pages that are neither settings nor the chat, so nothing is hidden. */
const WORKING_PAGES = [
  "/home",
  "/meetings/mtg_1",
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

describe("what the header offers to create", () => {
  it("offers nothing on the chat", () => {
    expect(headerChrome("/ask").create).toBe("none");
  });

  it("offers nothing on a chat with an id, if there is ever one", () => {
    // A string compare at the call site would drop this rule the day the route
    // grows a segment, and the buttons would come back without anyone deciding.
    expect(headerChrome("/ask/thr_1").create).toBe("none");
  });

  it("does not treat a path that merely starts the same as the chat", () => {
    expect(headerChrome("/asking").create).toBe("meeting");
  });

  it("offers a folder on the folder list, not a meeting", () => {
    // The one page whose obvious next action is not recording something.
    expect(headerChrome("/projects").create).toBe("folder");
    expect(headerChrome("/projects/").create).toBe("folder");
  });

  it("offers a meeting again inside a folder", () => {
    // Filing a call into the folder you are looking at is exactly the moment
    // to record one.
    expect(headerChrome("/projects/prj_1").create).toBe("meeting");
  });

  it("offers nothing on Account Settings, under every URL it answers to", () => {
    // Changing a setting and capturing a call are different sittings, and the
    // buttons there were an invitation to walk away from a half-filled form.
    expect(headerChrome("/settings").create).toBe("none");
    for (const tab of SETTINGS_TABS) {
      expect(headerChrome(pathForTab(tab.id)).create).toBe("none");
    }
    for (const path of Object.keys(LEGACY_PATHS)) {
      expect(headerChrome(path).create).toBe("none");
    }
  });

  it("offers a meeting everywhere else", () => {
    for (const path of WORKING_PAGES) {
      expect(headerChrome(path).create).toBe("meeting");
    }
  });
});

describe("the folder whose actions belong in the header", () => {
  it("is the one being looked at", () => {
    expect(headerChrome("/projects/prj_1").folderId).toBe("prj_1");
  });

  it("is nothing on the folder list itself", () => {
    // Rename and delete need a folder. On the list there are many, and the
    // per-row menus are where they belong.
    expect(headerChrome("/projects").folderId).toBeNull();
  });

  it("is nothing on a deeper path under a folder", () => {
    // Guards the id being read positionally: a third segment means this is not
    // the folder page, and taking parts[1] anyway would put a stale folder's
    // rename and delete in the header.
    expect(headerChrome("/projects/prj_1/anything").folderId).toBeNull();
  });

  it("is nothing anywhere else", () => {
    const notAFolder = WORKING_PAGES.filter((p) => p !== "/projects/prj_1");
    for (const path of [...notAFolder, "/ask", "/settings", "/billing"]) {
      expect(headerChrome(path).folderId).toBeNull();
    }
  });
});

describe("the two pages that strip the header", () => {
  it("leaves Account Settings with nothing in it", () => {
    // Deliberate, and the only page where both rules fire at once. Asserted
    // rather than left implicit: an empty bar looks like a rendering failure,
    // and the next person to see one should find this test before they
    // "fix" it.
    const chrome = headerChrome("/settings/emails");
    expect(chrome.search).toBe(false);
    expect(chrome.create).toBe("none");
  });

  it("leaves the chat with search and nothing else", () => {
    const chrome = headerChrome("/ask");
    expect(chrome.search).toBe(true);
    expect(chrome.create).toBe("none");
  });

  it("strips nothing on any page that is neither", () => {
    for (const path of [...WORKING_PAGES, "/projects"]) {
      const chrome = headerChrome(path);
      expect(chrome.search).toBe(true);
      expect(chrome.create).not.toBe("none");
    }
  });
});
