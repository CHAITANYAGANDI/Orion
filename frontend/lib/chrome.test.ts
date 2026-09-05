import { describe, it, expect } from "vitest";

import { bandChrome } from "@/lib/chrome";
import { placeFor } from "@/lib/places";
import { SETTINGS_TABS, LEGACY_PATHS, pathForTab } from "@/lib/settings-tabs";

/**
 * What the band carries, page by page.
 *
 * <h2>What this file used to assert, and why it does not any more</h2>
 *
 * <p>It pinned `headerChrome`: search absent on Account Settings, Import and
 * Record absent on the chat, on a meeting and on every settings URL, plus a
 * `bare` flag for the pages that ended up with an empty 64px bar. Those rules
 * are gone with the bar they refereed — see the header comment on lib/chrome.ts
 * and feature-parity §8. Deleting the assertions without replacing them would
 * have left the one rule that still matters untested, so the same URLs are
 * walked here against the opposite expectation: the band is the same shape
 * everywhere, and the tests say so route by route rather than in general.
 *
 * <p>The failure mode is unchanged and is why this is exhaustive rather than
 * representative: a control that is present on one URL of a page and absent on
 * another that renders the identical screen. Nobody reports that — it reads as
 * chrome flickering at random.
 */

/** Ordinary pages. Every one of them offers a new meeting. */
const WORKING_PAGES = [
  "/home",
  "/library",
  "/folders",
  "/folder/prj_1",
  "/ask",
  "/meetings/mtg_1",
  "/action-items",
  "/upload",
];

/** Every URL Account Settings answers to. */
const SETTINGS_PAGES = [
  "/settings",
  ...SETTINGS_TABS.map((tab) => pathForTab(tab.id)),
  ...Object.keys(LEGACY_PATHS),
];

/** The page that exists to record, and anything under it. */
const CAPTURING_PAGES = ["/record", "/record/live"];

describe("what the band offers to create", () => {
  it("offers a meeting on every ordinary page", () => {
    for (const path of WORKING_PAGES) {
      expect(bandChrome(path).create).toBe(true);
    }
  });

  it("offers a meeting on Account Settings too, under every URL it answers to", () => {
    // The old rule — "changing a setting and capturing a call are different
    // sittings" — was true of a bar the settings page shared. The band is not
    // shared with anything, and a band that loses two of its five controls when
    // you open Settings is the flicker this whole file is here to prevent.
    for (const path of SETTINGS_PAGES) {
      expect(bandChrome(path).create).toBe(true);
    }
  });

  it("offers nothing on the page that exists to record", () => {
    // A prefix, so a future /record/:id cannot quietly put Record back on the
    // page that is already recording.
    for (const path of CAPTURING_PAGES) {
      expect(bandChrome(path).create).toBe(false);
    }
  });

  it("offers nothing on any other page either, while a recording is in hand", () => {
    // The point of the rule. The recorder survives navigation, so wandering
    // onto Home must not put Import and Record back over a live microphone.
    for (const path of [...WORKING_PAGES, ...SETTINGS_PAGES]) {
      expect(bandChrome(path, true).create).toBe(false);
    }
  });

  it("puts them back the moment the recorder is empty", () => {
    // Held audio is the condition, not having ever recorded. After a save or a
    // discard the band has to come back on its own.
    expect(bandChrome("/home", false).create).toBe(true);
  });

  it("treats a path that merely starts the same as an ordinary page", () => {
    expect(bandChrome("/records").create).toBe(true);
    expect(bandChrome("/recordings/mtg_1").create).toBe(true);
  });
});

describe("the folder whose actions belong beside the page", () => {
  it("is the one being looked at", () => {
    expect(bandChrome("/folder/prj_1").folderId).toBe("prj_1");
  });

  it("survives a query string, since a return path carries one", () => {
    expect(bandChrome("/folder/prj_1?sort=name").folderId).toBe("prj_1");
  });

  it("is nothing on the folder list itself", () => {
    // Rename and delete need a folder. On the list there are many, and the
    // per-row menus are where they belong.
    expect(bandChrome("/folders").folderId).toBeNull();
    expect(bandChrome("/library").folderId).toBeNull();
  });

  it("is nothing on a deeper path under a folder", () => {
    // Guards the id being read positionally: a third segment means this is not
    // the folder page, and taking parts[1] anyway would put a stale folder's
    // rename and delete beside a page it does not belong to.
    expect(bandChrome("/folder/prj_1/anything").folderId).toBeNull();
  });

  it("is nothing anywhere else", () => {
    const notAFolder = WORKING_PAGES.filter((p) => p !== "/folder/prj_1");
    for (const path of [...notAFolder, ...CAPTURING_PAGES, ...SETTINGS_PAGES]) {
      expect(bandChrome(path).folderId).toBeNull();
    }
  });
});

/**
 * The band's own state, which is the other half of "where am I".
 *
 * <p>Kept in the same file as the create rule because together they are the
 * whole of what the band renders differently from one page to the next, and
 * splitting them across two files is how one of them gets a rule the other
 * contradicts.
 */
describe("which place a page is in", () => {
  it("puts each of the three on itself", () => {
    expect(placeFor("/home")).toEqual({ id: "now", nested: false });
    expect(placeFor("/library")).toEqual({ id: "library", nested: false });
    expect(placeFor("/ask")).toEqual({ id: "ask", nested: false });
  });

  it("tolerates a trailing slash, which a link can carry", () => {
    expect(placeFor("/home/")).toEqual({ id: "now", nested: false });
    expect(placeFor("/library/")).toEqual({ id: "library", nested: false });
    expect(placeFor("/ask/")).toEqual({ id: "ask", nested: false });
  });

  it("ignores a query string and a hash", () => {
    expect(placeFor("/library?sort=name")).toEqual({ id: "library", nested: false });
    expect(placeFor("/meetings/mtg_1#t=120")).toEqual({ id: "library", nested: true });
  });

  it("keeps Library lit, dimmed, one level down", () => {
    // The rule the old rail got for free: something is always lit. Three words
    // that all go quiet inside a meeting read as navigation that has stopped
    // working, and a meeting is where people spend most of their time.
    for (const path of ["/folders", "/folder/prj_1", "/meetings/mtg_1", "/meetings/mtg_1/anything"]) {
      expect(placeFor(path)).toEqual({ id: "library", nested: true });
    }
  });

  it("puts a page in no place where it is a thing you are doing", () => {
    // Not a gap. Each of these is entered from a control of its own and left by
    // finishing, and underlining a destination nobody navigated to would be a
    // lie about where they are.
    for (const path of ["/record", "/settings", "/settings/plans", "/welcome", "/upload", "/"]) {
      expect(placeFor(path)).toEqual({ id: null, nested: false });
    }
  });

  it("does not treat a path that merely starts the same as a place", () => {
    expect(placeFor("/asking")).toEqual({ id: null, nested: false });
    expect(placeFor("/homework")).toEqual({ id: null, nested: false });
  });

  it("answers for nothing at all", () => {
    // usePathname is typed as string but is null during the first render of a
    // few Next builds, and a band that throws there takes the whole app with it.
    expect(placeFor(null)).toEqual({ id: null, nested: false });
    expect(placeFor(undefined)).toEqual({ id: null, nested: false });
    expect(placeFor("")).toEqual({ id: null, nested: false });
  });
});
