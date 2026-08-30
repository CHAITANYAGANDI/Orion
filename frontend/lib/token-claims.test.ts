import { describe, it, expect } from "vitest";
import { readTokenClaims, tokenBelongsTo } from "@/lib/token-claims";

/**
 * Reading a credential to find out whose it is.
 *
 * <p>This runs in front of every request the app makes, which decides most of
 * what is asserted here: it must be total. Half of these cases are deliberate
 * rubbish, because the one thing a token check must never do is throw — an
 * exception in `prepareHeaders` is not a failed request, it is a blank
 * application.
 *
 * <p>The other half is the claim that matters. `sid` names the Clerk session a
 * token was minted for, and a token naming a session that is not the one the
 * app is open for is the bug this file exists for: Clerk's `getToken()` can
 * still be holding the previous sign-in's JWT, that JWT still verifies, and the
 * API answers it — with somebody else's account.
 */

/** A JWT, near enough: nothing here verifies a signature. */
function jwt(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.c2ln`;
}

describe("what a token says about itself", () => {
  it("reads the session and the subject", () => {
    const token = jwt({ sid: "sess_2xK", sub: "user_3IU", exp: 1 });

    expect(readTokenClaims(token)).toEqual({ sid: "sess_2xK", sub: "user_3IU" });
  });

  it("decodes base64url, which is not base64", () => {
    // `-` and `_` stand in for `+` and `/`, and the padding is dropped. A
    // decoder that ignores that fails on roughly one token in eight.
    const claims = { sid: "sess_??>>~~", sub: "user_<<??" };
    const token = jwt(claims);

    expect(readTokenClaims(token)).toEqual(claims);
    expect(token.split(".")[1]).not.toMatch(/[+/=]/);
  });

  it("survives a claim that is not ASCII", () => {
    const token = jwt({ sid: "sess_1", sub: "user_café_日本" });

    expect(readTokenClaims(token).sub).toBe("user_café_日本");
  });

  it("says nothing when the token names no session", () => {
    // A JWT template can be configured without `sid`. That is a supported way
    // to run Clerk, not a token to refuse.
    expect(readTokenClaims(jwt({ sub: "user_1" })).sid).toBeNull();
  });

  it("treats an empty claim as no claim", () => {
    expect(readTokenClaims(jwt({ sid: "", sub: "" }))).toEqual({ sid: null, sub: null });
  });

  it("treats a claim of the wrong type as no claim", () => {
    expect(readTokenClaims(jwt({ sid: 42, sub: { nested: true } }))).toEqual({
      sid: null,
      sub: null,
    });
  });
});

describe("things that are not tokens", () => {
  it.each([
    ["the empty string", ""],
    ["one segment", "tok_opaque"],
    ["two segments", "header.payload"],
    ["a payload that is not base64", "a.!!!!.c"],
    ["a payload that is not JSON", `a.${Buffer.from("hello").toString("base64url")}.c`],
    ["a payload that is JSON but not an object", `a.${Buffer.from("[1,2]").toString("base64url")}.c`],
    ["a payload that is null", `a.${Buffer.from("null").toString("base64url")}.c`],
  ])("answers 'it does not say' for %s, rather than throwing", (_label, token) => {
    expect(() => readTokenClaims(token)).not.toThrow();
    expect(readTokenClaims(token)).toEqual({ sid: null, sub: null });
  });
});

describe("whether a token may be sent for a session", () => {
  it("accepts the session's own token", () => {
    expect(tokenBelongsTo(jwt({ sid: "sess_1" }), "sess_1")).toBe(true);
  });

  it("refuses a token minted for another session", () => {
    // The whole point. This token verifies, it has not expired, and the API
    // will answer it — for the account it was minted for.
    expect(tokenBelongsTo(jwt({ sid: "sess_OLD" }), "sess_NEW")).toBe(false);
  });

  it("accepts a token that names no session at all", () => {
    // Permissive in one direction only: what cannot be disproven is allowed,
    // what proves itself wrong is refused. Otherwise a JWT template without
    // `sid` would be an app that never loads.
    expect(tokenBelongsTo(jwt({ sub: "user_1" }), "sess_1")).toBe(true);
    expect(tokenBelongsTo("tok_opaque", "sess_1")).toBe(true);
  });
});
