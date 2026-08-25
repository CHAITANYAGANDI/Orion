/**
 * What a new password has to satisfy, and why it is shown as a list.
 *
 * Four rules, each checked independently and each rendered with its own tick.
 * A single "password not strong enough" message makes somebody guess which part
 * they got wrong, and they usually guess by adding characters to the end — so
 * the list is not decoration, it is the difference between one attempt and
 * five.
 *
 * Deliberately modest. Length is the only requirement that reliably buys
 * anything, and a long list of character classes pushes people towards
 * `Password1!` — which satisfies every rule here and is on every wordlist. The
 * real protection against that is the breach check the identity provider runs
 * on submit, which no client-side rule can replace.
 */

export interface PasswordRule {
  id: string;
  label: string;
  ok: (value: string) => boolean;
}

export const PASSWORD_RULES: PasswordRule[] = [
  { id: "length", label: "At least 8 characters", ok: (v) => v.length >= 8 },
  { id: "upper", label: "At least 1 uppercase letter", ok: (v) => /[A-Z]/.test(v) },
  { id: "lower", label: "At least 1 lowercase letter", ok: (v) => /[a-z]/.test(v) },
  { id: "digit", label: "At least 1 number", ok: (v) => /[0-9]/.test(v) },
];

export interface PasswordCheck {
  /** Rule id -> whether the candidate satisfies it. */
  rules: Record<string, boolean>;
  /** Every rule satisfied. */
  strong: boolean;
  /** The two entries match, and the confirmation is not empty. */
  matches: boolean;
  /**
   * Why Update is unavailable, or null when it is available.
   *
   * One reason at a time, in the order somebody fills the form in. Showing
   * "passwords do not match" while they are still typing the second one is
   * noise that trains people to ignore the message.
   */
  blocker: string | null;
}

export function checkPassword(
  current: string,
  next: string,
  confirm: string,
): PasswordCheck {
  const rules: Record<string, boolean> = {};
  for (const rule of PASSWORD_RULES) rules[rule.id] = rule.ok(next);
  const strong = PASSWORD_RULES.every((r) => rules[r.id]);
  const matches = confirm.length > 0 && next === confirm;

  let blocker: string | null = null;
  if (!current) blocker = "Enter your current password";
  else if (!next) blocker = "Enter a new password";
  else if (!strong) blocker = "Your new password does not meet the rules yet";
  else if (!confirm) blocker = "Confirm your new password";
  else if (!matches) blocker = "The two new passwords do not match";
  // Changing a password to the one already in use is a no-op dressed as a
  // security action, and it teaches somebody that they have rotated a
  // credential they have not.
  else if (current === next) blocker = "That is the password you already have";

  return { rules, strong, matches, blocker };
}
