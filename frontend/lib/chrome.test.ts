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
 * before somebody tries to fix it.
 */

/** Pages that offer a new meeting, because none of the rules apply to them. */
const WORKING_PAGES = [
  "/home",
  "/folder/prj_1",
  "/action-items",
  "/search",
  "/upload",
];

/**
 * Not in WORKING_PAGES, and that is the rule under test. A meeting carries its
 * own Share, Export and overflow menu, which act on the document being read;
 * Import and Record make a different one. Both at the same end of the same bar
 * were five buttons that looked like one toolbar.
 */
const MEETING_PAGE = "/meetings/mtg_1";

/** Pages and states where the two buttons that make a meeting are withheld. */
const CAPTURING_PAGES = ["/record", "/record/live"];

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
    for (const path of [...WORKING_PAGES, MEETING_PAGE]) {
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
    expect(headerChrome("/folders").create).toBe("folder");
    expect(headerChrome("/folders/").create).toBe("folder");
  });

  it("offers a meeting again inside a folder", () => {
    // Filing a call into the folder you are looking at is exactly the moment
    // to record one.
    expect(headerChrome("/folder/prj_1").create).toBe("meeting");
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

  it("offers nothing on a meeting, which has controls of its own", () => {
    // A prefix rather than an exact match, so every id and any sub-route a
    // meeting grows later is covered by the same rule. Getting this wrong is
    // invisible in review and obvious on screen: the buttons would reappear on
    // one URL of the same page.
    expect(headerChrome(MEETING_PAGE).create).toBe("none");
    expect(headerChrome("/meetings/mtg_1/anything").create).toBe("none");
  });
});

describe("while a recording is in hand", () => {
  it("offers nothing to create on the page that exists to record", () => {
    // Record here would be offering to start what is already running.
    for (const path of CAPTURING_PAGES) {
      expect(headerChrome(path).create).toBe("none");
    }
  });

  it("offers nothing to create on any other page either, while recording", () => {
    // The point of the rule: the recorder survives navigation, so wandering
    // onto Home must not put Import and Record back over a live microphone.
    for (const path of WORKING_PAGES) {
      expect(headerChrome(path, true).create).toBe("none");
    }
  });

  it("still offers a folder on the folder list", () => {
    // Filing something is not making a second recording, and the folder list
    // has no other action of its own.
    expect(headerChrome("/folders", true).create).toBe("folder");
  });

  it("leaves search alone, since finding a meeting does not make one", () => {
    expect(headerChrome("/record").search).toBe(true);
    expect(headerChrome("/home", true).search).toBe(true);
  });

  it("puts them back the moment the recorder is empty", () => {
    // Held audio is the condition, not having ever recorded. After a save or a
    // discard the header has to come back on its own.
    expect(headerChrome("/home", false).create).toBe("meeting");
  });

  it("treats a path that merely starts the same as an ordinary page", () => {
    expect(headerChrome("/records").create).toBe("meeting");
  });
});

describe("the folder whose actions belong in the header", () => {
  it("is the one being looked at", () => {
    expect(headerChrome("/folder/prj_1").folderId).toBe("prj_1");
  });

  it("is nothing on the folder list itself", () => {
    // Rename and delete need a folder. On the list there are many, and the
    // per-row menus are where they belong.
    expect(headerChrome("/folders").folderId).toBeNull();
  });

  it("is nothing on a deeper path under a folder", () => {
    // Guards the id being read positionally: a third segment means this is not
    // the folder page, and taking parts[1] anyway would put a stale folder's
    // rename and delete in the header.
    expect(headerChrome("/folder/prj_1/anything").folderId).toBeNull();
  });

  it("is nothing anywhere else", () => {
    const notAFolder = WORKING_PAGES.filter((p) => p !== "/folder/prj_1");
    for (const path of [...notAFolder, MEETING_PAGE, ...CAPTURING_PAGES, "/ask", "/settings", "/billing"]) {
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
    for (const path of [...WORKING_PAGES, "/folders"]) {
      const chrome = headerChrome(path);
      expect(chrome.search).toBe(true);
      expect(chrome.create).not.toBe("none");
    }
    // A meeting keeps search; only its create control stands down. Finding the
    // next meeting from inside one is how people move between them.
    expect(headerChrome(MEETING_PAGE).search).toBe(true);
    expect(headerChrome(MEETING_PAGE).bare).toBe(false);
  });
});

describe("an empty top bar", () => {
  it("is reported on every settings tab", () => {
    // Search is stripped there and there is nothing to create, so all that
    // remains is the button that opens the rail — and that is hidden from lg
    // up. What was left was sixty-four pixels of nothing above the title.
    for (const path of ["/settings", "/settings/general", "/settings/integrations", "/billing"]) {
      const chrome = headerChrome(path);
      if (chrome.search || chrome.create !== "none") continue;
      expect(chrome.bare).toBe(true);
    }
    expect(headerChrome("/settings").bare).toBe(true);
  });

  it("is not reported where the bar still has something in it", () => {
    // Dropping the bar on these would take search with it.
    for (const path of [...WORKING_PAGES, MEETING_PAGE, "/ask", "/folders", "/record"]) {
      expect(headerChrome(path).bare).toBe(false);
    }
  });

  it("never claims to be empty while it is still holding search", () => {
    // The two must not disagree: a bar that is dropped while it carries the
    // only way to search is a feature deleted by a layout tweak.
    for (const path of ["/home", "/settings", "/ask", MEETING_PAGE, "/folder/prj_1"]) {
      const chrome = headerChrome(path);
      if (chrome.bare) expect(chrome.search).toBe(false);
    }
  });
});
