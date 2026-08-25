import { describe, it, expect } from "vitest";
import { avatarFromFile, AvatarError, initialsOf } from "@/lib/avatar";

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
