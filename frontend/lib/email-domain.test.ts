import { describe, it, expect } from "vitest";
import { suggestAddress } from "@/lib/email-domain";

/**
 * The typo that looks like a broken product.
 *
 * <p>A mistyped address in a form that sends a code fails silently and
 * expensively: the send succeeds, the screen says a code is on its way, and
 * nothing ever arrives, because `gmaill.com` is a real place as far as the mail
 * system is concerned and it is not anybody's inbox.
 */

describe("what it catches", () => {
  it.each([
    ["a@gmaill.com", "a@gmail.com"],
    ["a@gmai.com", "a@gmail.com"],
    ["a@gmial.com", "a@gmail.com"],
    ["a@gmail.co", "a@gmail.com"],
    ["a@hotmial.com", "a@hotmail.com"],
    ["a@outlok.com", "a@outlook.com"],
    ["a@yaho.com", "a@yahoo.com"],
    ["a@iclould.com", "a@icloud.com"],
  ])("reads %s as %s", (typed, meant) => {
    expect(suggestAddress(typed)).toBe(meant);
  });

  it("catches a swap, which is two edits by the usual measure", () => {
    // gmial is the commonest misspelling of the commonest domain there is. A
    // rule that left transposition out would miss the case most worth catching.
    expect(suggestAddress("chaitanya@gmial.com")).toBe("chaitanya@gmail.com");
  });

  it("keeps the local part exactly as it was typed", () => {
    // It is a name somebody chose. There is nothing to compare it to and no
    // business second-guessing it.
    expect(suggestAddress("Ada.Lovelace+orion@gmaill.com")).toBe(
      "Ada.Lovelace+orion@gmail.com",
    );
  });

  it("reads a shouted domain, since that is not the mistake", () => {
    expect(suggestAddress("ada@GMAILL.COM")).toBe("ada@gmail.com");
  });
});

describe("what it leaves alone", () => {
  it("says nothing about an address that is already right", () => {
    expect(suggestAddress("ada@gmail.com")).toBeNull();
    expect(suggestAddress("ada@GMAIL.COM")).toBeNull();
  });

  it("says nothing about a company domain", () => {
    // It has no famous neighbour to be confused with, and a form that argues
    // with somebody about their own work address is worse than the typo.
    expect(suggestAddress("ada@northeastern.edu")).toBeNull();
    expect(suggestAddress("ada@orion.example")).toBeNull();
  });

  it("does not reach for a domain two edits away", () => {
    expect(suggestAddress("ada@gmmaill.com")).toBeNull();
  });

  it("answers a half-typed address rather than guessing at it", () => {
    // This runs while somebody is still typing. Every one of these is a state
    // the field passes through on the way to being right.
    expect(suggestAddress("")).toBeNull();
    expect(suggestAddress("ada")).toBeNull();
    expect(suggestAddress("ada@")).toBeNull();
    expect(suggestAddress("@gmaill.com")).toBeNull();
  });
});
