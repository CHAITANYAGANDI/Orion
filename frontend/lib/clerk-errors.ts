/**
 * One sentence, in Reverie's voice, for anything the credential provider refuses.
 *
 * <h2>Why this exists</h2>
 *
 * <p>Reverie builds its own sign-in and sign-up forms, which means it owns the
 * part of a sign-in that goes wrong. Clerk answers a failure with an array of
 * error objects carrying a `code`, a `message`, a `longMessage` and sometimes
 * the name of the parameter at fault — good material for a developer and the
 * wrong thing to put on a screen. `identifier_not_found` is not a sentence, and
 * "Password is incorrect. Try again, or use another method." is Clerk's voice
 * rather than ours.
 *
 * <p>So the codes that a person can actually do something about are answered
 * here, and everything else falls back to one honest line. Nothing is invented:
 * where Clerk's own message is fit to read, it is used.
 *
 * <h2>What is deliberately not said</h2>
 *
 * <p>Whether an address has an account. `identifier_not_found` and a wrong
 * password get the <em>same</em> sentence, because a sign-in form that tells
 * the difference is an endpoint for checking which of your colleagues has an
 * account here. That costs a little clarity for somebody who mistyped their
 * address, and it is worth it.
 */

/** The shape Clerk returns. Structural, so nothing here imports its runtime. */
interface ClerkErrorLike {
  code?: string;
  message?: string;
  longMessage?: string;
}

interface ClerkErrorResponse {
  errors?: ClerkErrorLike[];
}

/** What to say when there is nothing more specific and nothing worth quoting. */
const FALLBACK = "Something went wrong. Try again.";

/**
 * Codes worth answering in our own words.
 *
 * <p>Each of these is a state the person is in, described as what to do next.
 * Clerk's own wording for the rest is usually fine and is used as-is.
 */
const SAID_BETTER: Record<string, string> = {
  // The pair that must not be distinguishable. See the note above.
  form_identifier_not_found: "That email and password do not match an account.",
  form_password_incorrect: "That email and password do not match an account.",
  form_param_format_invalid: "That does not look like an email address.",
  form_param_nil: "Fill in every field to continue.",
  form_identifier_exists: "There is already an account with that email. Sign in instead.",
  form_password_pwned:
    "That password has appeared in a public breach. Choose one you have not used elsewhere.",
  form_password_length_too_short: "Use at least 8 characters.",
  form_code_incorrect: "That code is not right. Check it and try again.",
  verification_expired: "That code has expired. Send a new one.",
  /*
   * Reached only when the recovery in the sign-up form could not read where the
   * sign-up got to. Clerk's own sentence -- "This verification has already been
   * verified." -- reports a success as a failure, on a screen whose only two
   * buttons both produce it.
   */
  verification_already_verified: "Your email is already confirmed. Sign in to continue.",
  session_exists: "You are already signed in.",
  captcha_invalid: "We could not confirm you are not a robot. Reload and try again.",
  too_many_requests: "Too many attempts. Wait a minute and try again.",
};

/**
 * The one line to show for a failed authentication step.
 *
 * <p>Total, like every other error path in this app: an unrecognised shape, a
 * network failure, a thrown string, and `undefined` all answer the fallback
 * rather than throwing. This runs inside a `catch`, and a `catch` that can
 * throw leaves a form with a spinner on it for ever.
 */
export function authErrorMessage(error: unknown): string {
  const first = firstError(error);
  if (!first) return FALLBACK;

  if (first.code && SAID_BETTER[first.code]) return SAID_BETTER[first.code];

  /*
   * Clerk's own sentence, where it has one worth reading. `longMessage` is the
   * one written for a person ("Enter a valid email address."); `message` is
   * usually a fragment ("is invalid"). Neither is trusted to be short.
   */
  const said = (first.longMessage || first.message || "").trim();
  if (!said) return FALLBACK;
  return said.length > 160 ? FALLBACK : said;
}

function firstError(error: unknown): ClerkErrorLike | null {
  if (!error || typeof error !== "object") return null;
  const errors = (error as ClerkErrorResponse).errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = errors[0];
  return first && typeof first === "object" ? first : null;
}

/**
 * Whether a failure is the one that means "you already are signed in".
 *
 * <p>Reachable by opening a sign-in page in a second tab and using the first
 * one, then coming back. There is nothing wrong to report — the answer is to
 * go where they were going.
 */
export function isAlreadySignedIn(error: unknown): boolean {
  return firstError(error)?.code === "session_exists";
}

/**
 * Whether a failure is the one that means "that code already worked".
 *
 * <p>Clerk raises it for a second attempt at a verification it has already
 * taken, and for a resend on one — which is where a lost response, a double
 * submit, or a sign-up that verified without completing all end up. It is not a
 * failure of anything: the address is confirmed, and the answer is to read
 * where the sign-up actually got to rather than to report an error.
 *
 * <p>Matched on the substring rather than the exact code, because the same
 * condition is spelled `verification_already_verified` in some responses and
 * with a prefix in others, and nothing unrelated says "already verified".
 */
export function isAlreadyVerified(error: unknown): boolean {
  return (firstError(error)?.code ?? "").includes("already_verified");
}
