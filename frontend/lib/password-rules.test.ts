import { describe, it, expect } from "vitest";
import { PASSWORD_RULES, checkPassword } from "@/lib/password-rules";

/**
 * The four rules and the one reason.
 *
 * The rules are shown as a live checklist, so each has to be independently
 * decidable — a single "not strong enough" makes somebody guess which part they
 * got wrong, and they guess by adding characters to the end.
 */
function rulesFor(candidate: string) {
  return checkPassword("Whatever1", candidate, candidate).rules;
}

describe("the rules", () => {
  it("are the four the dialog lists, in order", () => {
    expect(PASSWORD_RULES.map((r) => r.label)).toEqual([
      "At least 8 characters",
      "At least 1 uppercase letter",
      "At least 1 lowercase letter",
      "At least 1 number",
    ]);
  });

  it("each fail independently", () => {
    expect(rulesFor("Ab1")).toMatchObject({
      length: false,
      upper: true,
      lower: true,
      digit: true,
    });
    expect(rulesFor("abcdefg1")).toMatchObject({ upper: false, length: true });
    expect(rulesFor("ABCDEFG1")).toMatchObject({ lower: false });
    expect(rulesFor("Abcdefgh")).toMatchObject({ digit: false });
  });

  it("pass together on something reasonable", () => {
    const { strong } = checkPassword("OldPass1", "Correct9horse", "Correct9horse");
    expect(strong).toBe(true);
  });

  it("count a symbol towards length without requiring one", () => {
    // No symbol rule on purpose: adding one pushes people towards
    // "Password1!", which satisfies every rule and is on every wordlist.
    expect(rulesFor("Abcdefg1!")).toMatchObject({ length: true, digit: true });
    const { strong } = checkPassword("OldPass1", "Abcdefg1", "Abcdefg1");
    expect(strong).toBe(true);
  });
});

describe("what blocks Update", () => {
  it("asks for the current password first", () => {
    expect(checkPassword("", "", "").blocker).toMatch(/current password/i);
  });

  it("then for a new one", () => {
    expect(checkPassword("OldPass1", "", "").blocker).toMatch(/new password/i);
  });

  it("then that the new one meets the rules", () => {
    expect(checkPassword("OldPass1", "abc", "").blocker).toMatch(/rules/i);
  });

  it("then for the confirmation", () => {
    // Not "they do not match" while the second box is still empty: a message
    // that is true of every half-typed form trains people to ignore it.
    expect(checkPassword("OldPass1", "NewPass99", "").blocker).toMatch(/confirm/i);
  });

  it("then that the two agree", () => {
    expect(checkPassword("OldPass1", "NewPass99", "NewPass98").blocker).toMatch(/do not match/i);
  });

  it("refuses the password already in use", () => {
    // A no-op dressed as a security action teaches somebody they have rotated
    // a credential they have not.
    expect(checkPassword("NewPass99", "NewPass99", "NewPass99").blocker)
      .toMatch(/already have/i);
  });

  it("is null once everything is satisfied", () => {
    expect(checkPassword("OldPass1", "NewPass99", "NewPass99").blocker).toBeNull();
  });

  it("does not treat a matching pair as confirmed when both are empty", () => {
    expect(checkPassword("OldPass1", "", "").matches).toBe(false);
  });
});
