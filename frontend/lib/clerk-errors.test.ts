import { describe, it, expect } from "vitest";
import { authErrorMessage, isAlreadySignedIn } from "@/lib/clerk-errors";

/**
 * What a failed sign-in is allowed to say.
 *
 * <p>Two rules run through all of it. It must never throw — this is called from
 * a `catch`, and a `catch` that throws leaves a spinner on the button for ever.
 * And it must never say whether an address has an account, because a form that
 * tells the difference is a way to find out who else signed up.
 */

/** Clerk's shape. */
function clerk(code: string, message?: string, longMessage?: string) {
  return { errors: [{ code, message, longMessage }] };
}

describe("the pair that must not be distinguishable", () => {
  it("says the same thing for an unknown address as for a wrong password", () => {
    const unknown = authErrorMessage(clerk("form_identifier_not_found"));
    const wrong = authErrorMessage(clerk("form_password_incorrect"));

    expect(unknown).toBe(wrong);
    expect(unknown).toBe("That email and password do not match an account.");
  });

  it("never reveals that an account exists", () => {
    // The words to avoid, in either direction: "no account with that email"
    // and "wrong password" are both answers to a question nobody asked.
    for (const code of ["form_identifier_not_found", "form_password_incorrect"]) {
      const said = authErrorMessage(clerk(code)).toLowerCase();
      expect(said).not.toMatch(/no account|not found|does not exist|incorrect password/);
    }
  });
});

describe("failures somebody can act on", () => {
  it.each([
    ["form_identifier_exists", /already an account/i],
    ["form_password_pwned", /breach/i],
    ["form_password_length_too_short", /8 characters/i],
    ["form_code_incorrect", /code is not right/i],
    ["verification_expired", /expired/i],
    ["too_many_requests", /wait a minute/i],
  ])("answers %s with what to do next", (code, expected) => {
    expect(authErrorMessage(clerk(code))).toMatch(expected);
  });
});

describe("anything else", () => {
  it("quotes Clerk's own sentence when it is fit to read", () => {
    const said = authErrorMessage(
      clerk("some_unmapped_code", "is invalid", "Enter a valid email address."),
    );

    // `longMessage` is the one written for a person; `message` is a fragment.
    expect(said).toBe("Enter a valid email address.");
  });

  it("falls back rather than printing an essay", () => {
    const said = authErrorMessage(clerk("x", undefined, "word ".repeat(60)));

    expect(said).toBe("Something went wrong. Try again.");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "boom"],
    ["an empty object", {}],
    ["an empty error list", { errors: [] }],
    ["a list of nothing", { errors: [null] }],
    ["a network Error", new TypeError("Failed to fetch")],
  ])("survives %s", (_label, thrown) => {
    expect(() => authErrorMessage(thrown)).not.toThrow();
    expect(authErrorMessage(thrown)).toBe("Something went wrong. Try again.");
  });
});

describe("already signed in", () => {
  it("is recognised, so the form can just go where it was going", () => {
    // Reachable with two tabs open. Nothing is wrong, so nothing should be
    // reported -- the answer is to continue.
    expect(isAlreadySignedIn(clerk("session_exists"))).toBe(true);
  });

  it("is not confused with an ordinary failure", () => {
    expect(isAlreadySignedIn(clerk("form_password_incorrect"))).toBe(false);
    expect(isAlreadySignedIn(null)).toBe(false);
  });
});
