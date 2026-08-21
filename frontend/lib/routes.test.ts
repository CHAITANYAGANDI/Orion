import { describe, it, expect } from "vitest";
import {
  FOLDERS,
  folderHref,
  folderIdFrom,
  isFolderListPath,
  recordHref,
  returnPath,
} from "@/lib/routes";

/**
 * The two paths that are written in one file and read in another.
 *
 * A folder's URL is built by the rail, the list and the record page, and parsed
 * by the header to decide whose rename and delete to show. `?r=` is written by
 * the Record button and read by the page it lands on, minutes before it decides
 * which folder a meeting files into. Both are strings crossing a gap, which is
 * the only kind of coupling worth a unit test of its own.
 */

describe("a folder's path", () => {
  it("round-trips the id", () => {
    expect(folderIdFrom(folderHref("prj_1"))).toBe("prj_1");
  });

  it("is not the folder list", () => {
    expect(folderIdFrom(FOLDERS)).toBeNull();
    expect(isFolderListPath(FOLDERS)).toBe(true);
    expect(isFolderListPath(`${FOLDERS}/`)).toBe(true);
    expect(isFolderListPath(folderHref("prj_1"))).toBe(false);
  });

  it("is read positionally, so a deeper path is not that folder", () => {
    // Taking parts[1] regardless would put a stale folder's rename and delete
    // in the header of a page below it.
    expect(folderIdFrom("/folder/prj_1/anything")).toBeNull();
  });

  it("survives search state on the end of it", () => {
    // A return path is whatever page Record was pressed on, query and all.
    expect(folderIdFrom("/folder/prj_1?sort=name")).toBe("prj_1");
  });

  it("is nothing for a path that is not a folder", () => {
    for (const path of ["/home", "/meetings/mtg_1", "/search", "/record", "/"]) {
      expect(folderIdFrom(path)).toBeNull();
    }
    expect(folderIdFrom(null)).toBeNull();
  });
});

describe("where a recording came from", () => {
  it("goes on the URL, encoded", () => {
    // The shape Otter uses, and for the same reason: /record has no folder in
    // it, so the page it was opened from has to travel with it.
    expect(recordHref("/folder/prj_1")).toBe("/record?r=%2Ffolder%2Fprj_1");
    expect(recordHref("/home")).toBe("/record?r=%2Fhome");
  });

  it("comes back as it went out", () => {
    const r = new URLSearchParams(recordHref("/folder/prj_1").split("?")[1]).get("r");
    expect(returnPath(r)).toBe("/folder/prj_1");
    expect(folderIdFrom(returnPath(r))).toBe("prj_1");
  });

  it("is Home when there is none", () => {
    expect(returnPath(null)).toBe("/home");
    expect(returnPath("")).toBe("/home");
  });

  it("refuses a URL wearing a path's clothes", () => {
    // `r` is read off the address bar and handed to router.push, so anything
    // carrying a host is an open redirect out of the app. This is the ordinary
    // way a return parameter goes wrong.
    expect(returnPath("//evil.example")).toBe("/home");
    expect(returnPath("/\\evil.example")).toBe("/home");
    expect(returnPath("https://evil.example")).toBe("/home");
    expect(returnPath("javascript:alert(1)")).toBe("/home");
  });

  it("refuses to send anybody back to the recorder", () => {
    // /record opens a microphone on arrival. Returning a discarded recording
    // to it would start another one.
    expect(returnPath("/record")).toBe("/home");
    expect(returnPath("/record?r=%2Fhome")).toBe("/home");
    expect(recordHref("/record")).toBe("/record?r=%2Fhome");
  });

  it("keeps any other page of the app, whole", () => {
    // Record is pressed from search results and from meetings too, and the way
    // back is that page, not the nearest folder.
    expect(returnPath("/search?q=budget")).toBe("/search?q=budget");
    expect(returnPath("/meetings/mtg_1")).toBe("/meetings/mtg_1");
  });
});
