import { describe, it, expect } from "vitest";
import {
  blockedMessage,
  completedSession,
  fillableFields,
  usernameFrom,
  type SignUpState,
} from "@/lib/clerk-signup";

/**
 * Verified is not the same as finished.
 *
 * <p>Clerk's sign-up completes only once every required field is present, so a
 * correct code can leave the attempt short of an account. The form used to
 * answer that with "check the code and try again" — sending somebody back to
 * re-enter a code Clerk had already accepted, which then failed as
 * `verification_already_verified`, as did Send another code. Every case here is
 * a step on that dead end.
 */

const MISSING: SignUpState = {
  status: "missing_requirements",
  missingFields: ["username"],
  createdSessionId: null,
};

const DONE: SignUpState = { status: "complete", missingFields: [], createdSessionId: "sess_1" };

describe("whether there is a session to switch to", () => {
  it("hands back the session of a finished sign-up", () => {
    expect(completedSession(DONE)).toBe("sess_1");
  });

  it("has none while a requirement is outstanding", () => {
    expect(completedSession(MISSING)).toBeNull();
  });

  it("refuses a complete sign-up that made no session", () => {
    /*
     * A real state: an instance can create the account without signing anybody
     * in. Passing null to `setActive` fails in a way that reads as a bug in the
     * code rather than as an account that is ready and waiting.
     */
    expect(completedSession({ ...DONE, createdSessionId: null })).toBeNull();
    expect(completedSession({ ...DONE, createdSessionId: "" })).toBeNull();
  });

  it("answers a shape it did not get rather than throwing", () => {
    // This runs on the way out of a `catch`. A throw here leaves a form with a
    // spinner on it for ever.
    expect(completedSession(null)).toBeNull();
    expect(completedSession(undefined)).toBeNull();
  });
});

describe("what Reverie will fill in for somebody", () => {
  it("supplies a username, because it is the field nothing reads back", () => {
    const fill = fillableFields(MISSING, "ada@example.com");

    expect(fill?.username).toMatch(/^ada-[0-9a-f]{6}$/);
  });

  it("supplies nothing when nothing it can answer is missing", () => {
    expect(fillableFields({ ...MISSING, missingFields: [] }, "ada@example.com")).toBeNull();
  });

  it("will not invent a name", () => {
    /*
     * A username is a value Reverie has nowhere to display. A first name is a
     * real answer about a real person, asked for on the first screen inside --
     * filling it with something plausible would be putting words in a mouth.
     */
    const fill = fillableFields({ ...MISSING, missingFields: ["first_name"] }, "ada@example.com");

    expect(fill).toBeNull();
  });

  it("reads a missing list it did not get as nothing to fill", () => {
    const shapeless = { status: null, createdSessionId: null } as unknown as SignUpState;

    expect(fillableFields(shapeless, "ada@example.com")).toBeNull();
  });
});

describe("the username it derives", () => {
  it("keeps the local part and drops the rest of the address", () => {
    expect(usernameFrom("ada.lovelace+reverie@example.com")).toMatch(/^adalovelacereverie-[0-9a-f]{6}$/);
  });

  it("is different every time, so two of the same address do not collide", () => {
    // Every info@ and hello@ in the world is the same six letters, and a
    // collision surfaces as "there is already an account with that email" --
    // a lie about a field nobody was shown.
    const names = new Set(Array.from({ length: 20 }, () => usernameFrom("info@example.com")));

    expect(names.size).toBe(20);
  });

  it("still produces a usable name from an address with nothing usable in it", () => {
    expect(usernameFrom("+++@example.com")).toMatch(/^reverie-[0-9a-f]{6}$/);
    expect(usernameFrom("")).toMatch(/^reverie-[0-9a-f]{6}$/);
  });

  it("stays short enough for a username field", () => {
    const long = `${"a".repeat(80)}@example.com`;

    expect(usernameFrom(long).length).toBeLessThanOrEqual(27);
  });
});

describe("what it says when the sign-up cannot be finished here", () => {
  it("never sends anybody back to the code", () => {
    /*
     * The bug. By the time any of these is read, the code is the one thing
     * known to have worked -- and re-entering it fails, and so does asking for
     * another, so the screen has no way out of itself.
     */
    const messages = [
      blockedMessage(MISSING),
      blockedMessage({ ...MISSING, missingFields: ["first_name"] }),
      blockedMessage({ ...DONE, createdSessionId: null }),
      blockedMessage(null),
    ];

    for (const message of messages) expect(message).not.toMatch(/code/i);
  });

  it("names the field that is in the way", () => {
    expect(blockedMessage({ ...MISSING, missingFields: ["first_name"] })).toContain("a first name");
  });

  it("names more than one of them in a sentence", () => {
    const message = blockedMessage({
      ...MISSING,
      missingFields: ["first_name", "last_name", "phone_number"],
    });

    expect(message).toContain("a first name, a last name and a phone number");
  });

  it("sends a finished account to the form that makes a session", () => {
    expect(blockedMessage({ ...DONE, createdSessionId: null })).toMatch(/Sign in/);
  });

  it("says the address is confirmed, because it is", () => {
    expect(blockedMessage(MISSING)).toMatch(/confirmed/i);
  });

  it("falls back to the road that works when it cannot name anything", () => {
    expect(blockedMessage({ ...MISSING, missingFields: ["something_new"] })).toMatch(/Google/);
    expect(blockedMessage(null)).toMatch(/Google/);
  });
});
