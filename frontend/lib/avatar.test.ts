import { describe, it, expect } from "vitest";
import { avatarFromFile, AvatarError, initialsOf } from "@/lib/avatar";
import { DEPARTMENTS, ROLES, withCurrent } from "@/lib/profile-options";

/**
 * The parts of the profile picture that are decidable without a canvas.
 *
 * jsdom has no 2D context, so the downscale itself is exercised in the browser
 * rather than here. What is pinned here is the gate in front of it — which file
 * types are allowed through at all — because that is a security boundary rather
 * than an image-processing detail.
 */
describe("avatarFromFile", () => {
  it("refuses SVG", async () => {
    // An SVG is an image everywhere else in a product and a script host here:
    // it can carry <script>, and it would run against whoever opened the
    // profile. The server refuses it too; this only fails sooner, in words.
    const svg = new Blob(["<svg xmlns='http://www.w3.org/2000/svg'/>"], {
      type: "image/svg+xml",
    });
    await expect(avatarFromFile(svg)).rejects.toBeInstanceOf(AvatarError);
  });

  it("refuses a file that is not an image at all", async () => {
    const pdf = new Blob(["%PDF-1.4"], { type: "application/pdf" });
    await expect(avatarFromFile(pdf)).rejects.toBeInstanceOf(AvatarError);
  });

  it("says something a person can act on", async () => {
    const pdf = new Blob([""], { type: "application/pdf" });
    await expect(avatarFromFile(pdf)).rejects.toThrow(/PNG, JPEG or WebP/);
  });
});

describe("initialsOf", () => {
  it("takes the first and last words, not the first two letters", () => {
    // "CH" is what a naive slice gives for this name, and it says nothing.
    expect(initialsOf("Chaitanyasai Gandi")).toBe("CG");
  });

  it("handles a middle name by ignoring it", () => {
    expect(initialsOf("Ada Byron Lovelace")).toBe("AL");
  });

  it("gives one letter for one word", () => {
    expect(initialsOf("Prince")).toBe("P");
  });

  it("falls back to the id only when there is no name", () => {
    expect(initialsOf(null, "usr_9yh6")).toBe("US");
  });

  it("admits it does not know rather than showing a stray character", () => {
    expect(initialsOf(null, null)).toBe("?");
    expect(initialsOf("   ")).toBe("?");
  });
});

describe("withCurrent", () => {
  it("leaves a listed value alone", () => {
    expect(withCurrent(DEPARTMENTS, "IT")).toEqual(DEPARTMENTS);
    expect(withCurrent(ROLES, "Manager")).toEqual(ROLES);
  });

  it("keeps a value the list does not have", () => {
    // These were free text before the pickers existed. Dropping the stored
    // value would make a <select> render the first option instead, silently
    // rewriting somebody's department the moment they opened the dialog.
    const options = withCurrent(DEPARTMENTS, "Platform Engineering");
    expect(options[0]).toBe("Platform Engineering");
    expect(options).toHaveLength(DEPARTMENTS.length + 1);
  });

  it("adds nothing for an empty value", () => {
    expect(withCurrent(ROLES, "")).toEqual(ROLES);
    expect(withCurrent(ROLES, null)).toEqual(ROLES);
    expect(withCurrent(ROLES, "   ")).toEqual(ROLES);
  });
});
