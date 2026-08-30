import { describe, it, expect } from "vitest";
import {
  identityOwner,
  identityPermissions,
  normalizeProvider,
  type Credential,
} from "@/lib/identity-owner";

/**
 * Which fields belong to this account holder, and which belong to Google.
 *
 * <h2>The bug this replaces</h2>
 *
 * <p>One question was asked — "is this deployment using Clerk?" — and both
 * kinds of account answer it the same way. So the address was locked for
 * everybody, including the person who signed up with an email and just wanted
 * to fix a typo in it; and everybody was offered a Change password button,
 * including the person who signs in with Google and has no password anywhere
 * for `updatePassword` to check.
 *
 * <p>Every case below is one of those two people.
 */

const GOOGLE: Credential = { mode: "clerk", provider: "google", hasPassword: false };
const ORION: Credential = { mode: "clerk", provider: "", hasPassword: true };
const DEV: Credential = { mode: "dev", provider: "", hasPassword: false };

describe("an account that signs in with Google", () => {
  it("owns neither of them here", () => {
    const can = identityPermissions(GOOGLE);

    expect(can).toMatchObject({ owner: "external", name: false, password: false });
  });

  it("says nothing at all about the address", () => {
    // Nobody changes their address in Orion, so there is no question left for
    // this module to answer about it. See lib/account-actions.
    expect(identityPermissions(GOOGLE)).not.toHaveProperty("email");
    expect(identityPermissions(GOOGLE)).not.toHaveProperty("emailVia");
  });

  it("names Google, so the sentence on screen can too", () => {
    expect(identityPermissions(GOOGLE).ownerLabel).toBe("Google");
  });

  it.each([
    ["github", "GitHub"],
    ["microsoft", "Microsoft"],
    ["apple", "Apple"],
  ])("names %s as well", (provider, label) => {
    expect(identityPermissions({ ...GOOGLE, provider }).ownerLabel).toBe(label);
  });

  it("keeps the generic phrase for a provider it does not know", () => {
    expect(identityPermissions({ ...GOOGLE, provider: "okta" }).ownerLabel).toBe(
      "your sign-in provider",
    );
  });

  it("stays Google's even after a password is added", () => {
    /*
     * Clerk lets an OAuth account set a password later. The name still comes
     * from Google, so editing it here would be editing a copy that the next
     * sign-in overwrites.
     */
    const can = identityPermissions({ ...GOOGLE, hasPassword: true });

    expect(can.owner).toBe("external");
    expect(can.name).toBe(false);
  });
});

describe("an account made with an email and a password", () => {
  it("owns both", () => {
    expect(identityPermissions(ORION)).toMatchObject({
      owner: "orion",
      name: true,
      password: true,
    });
  });

  it("has nobody else to name", () => {
    expect(identityPermissions(ORION).ownerLabel).toBe("");
  });
});

describe("a development session", () => {
  it("owns its name, and has no password in existence", () => {
    expect(identityPermissions(DEV)).toMatchObject({
      owner: "dev",
      name: true,
      password: false,
    });
  });
});

describe("failing closed", () => {
  it("locks an account under Clerk with neither a password nor a connection", () => {
    // Nothing here knows what that is, and every alternative ends in a form
    // that fails on submit. A disabled field with a sentence beside it is
    // understood; a form that accepts an edit and reverts it is reported as
    // data loss.
    const can = identityPermissions({ mode: "clerk", provider: "", hasPassword: false });

    expect(can.owner).toBe("external");
    expect(can.password).toBe(false);
    expect(can.name).toBe(false);
  });

  it("treats an unknown mode as having no provider rather than guessing", () => {
    expect(identityOwner({ mode: "", provider: "", hasPassword: false })).toBe("dev");
  });
});

describe("what Clerk calls a provider", () => {
  it.each([
    ["google", "google"],
    ["oauth_google", "google"],
    ["OAuth_Google", "google"],
    ["", ""],
    [null, ""],
    [undefined, ""],
  ])("reads %s as %s", (raw, expected) => {
    // Clerk spells it both ways depending on where it is read from. One
    // spelling reaches the rest of the app.
    expect(normalizeProvider(raw)).toBe(expected);
  });
});
