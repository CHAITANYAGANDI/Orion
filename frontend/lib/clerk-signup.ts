/**
 * Getting a sign-up over the line once the code comes back.
 *
 * <h2>The dead end this exists to end</h2>
 *
 * <p>Clerk's sign-up is progressive. `create` opens an attempt, the six-digit
 * code verifies the address, and the attempt becomes an account only once every
 * field the instance requires is present. So <em>verifying the address</em> and
 * <em>finishing the sign-up</em> are two different events, and the form used to
 * treat them as one: anything that came back other than `complete` was reported
 * as "That did not complete the sign-up. Check the code and try again."
 *
 * <p>That is the worst sentence available, because the code was right. Clerk
 * accepted it and the address is now verified — so the next attempt comes back
 * `verification_already_verified`, and so does Send another code, and the screen
 * has no way out of itself. Everything here exists to tell those two events
 * apart and to say something true about the difference.
 *
 * <h2>Which fields Orion will answer on somebody's behalf</h2>
 *
 * <p>A username, and nothing else. Orion has nowhere to put one — no profile,
 * no @mention, no sharing — so where an instance requires it, it is a value
 * nobody reads and asking for it would be a required field invented at the
 * exact moment somebody is deciding whether this product is worth the trouble.
 * A first name is different: it is a real answer about a real person, it is
 * asked for on the first screen inside, and filling it in with something
 * plausible would be putting words in their mouth.
 */

/** The parts of Clerk's sign-up resource that decide what happens next. */
export interface SignUpState {
  /** `"missing_requirements"` until every required field is present. */
  status: string | null;
  /** What Clerk is still waiting for: `"username"`, `"first_name"`, … */
  missingFields: string[];
  /** Only present once the account exists. */
  createdSessionId: string | null;
}

/** What can be sent to `signUp.update` without asking anybody anything. */
export interface SignUpFill {
  username?: string;
}

/**
 * The session this sign-up produced, or null if it did not produce one.
 *
 * <p>Both halves are checked. `complete` without a session id is a real state —
 * an instance can be configured to make the account without signing anybody in
 * — and passing a null id to `setActive` fails in a way that reads as a bug in
 * the code rather than as the account being ready.
 */
export function completedSession(state: SignUpState | null | undefined): string | null {
  if (!state || state.status !== "complete") return null;
  const session = state.createdSessionId;
  return typeof session === "string" && session.length > 0 ? session : null;
}

/**
 * What Orion can fill in so the sign-up can finish, or null if nothing.
 *
 * <p>Called before the code is sent as well as after it comes back. Before,
 * because finding out that an account cannot be created is worth knowing
 * without spending an email first; after, because a requirement can appear once
 * the address is verified.
 */
export function fillableFields(
  state: SignUpState | null | undefined,
  email: string,
): SignUpFill | null {
  return missingIn(state).includes("username") ? { username: usernameFrom(email) } : null;
}

/**
 * A username derived from the address, with enough noise on the end to be its
 * own.
 *
 * <p>The local part alone collides constantly — every `info@` and `hello@` in
 * the world is the same six letters — and a collision here surfaces as "there
 * is already an account with that email", which would be a lie about a field
 * nobody was shown. Three random bytes make that not happen, and the value is
 * never displayed anywhere in Orion.
 */
export function usernameFrom(email: string): string {
  const local = email.split("@")[0] ?? "";
  const base = local.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || "orion";
  return `${base}-${noise()}`;
}

/**
 * The one line for a sign-up that cannot be finished from this screen.
 *
 * <p>None of it says "check the code". The code is the one thing already known
 * to be right by the time anything here is read.
 */
export function blockedMessage(state: SignUpState | null | undefined): string {
  if (state?.status === "complete") {
    // The account exists; only the session does not. Sending them round to the
    // form that makes one is the whole remedy.
    return "Your account is ready. Sign in with your email and password to continue.";
  }

  const named = readable(missingIn(state));
  if (named) {
    return `Your email is confirmed, but this account also needs ${named}, which sign-up does not ask for.`;
  }
  return "Your email is confirmed, but the account could not be finished. Try Continue with Google.";
}

function missingIn(state: SignUpState | null | undefined): string[] {
  const missing = state?.missingFields;
  // A shape that did not arrive is not a requirement anything can name. The
  // sentence for that case is the general one.
  if (!Array.isArray(missing)) return [];
  return missing.filter((field): field is string => typeof field === "string");
}

/** Clerk's field names, as they would be said out loud. */
const FIELD_NAMES: Record<string, string> = {
  username: "a username",
  first_name: "a first name",
  last_name: "a last name",
  phone_number: "a phone number",
  password: "a password",
  email_address: "an email address",
};

function readable(fields: string[]): string {
  const named = fields.map((field) => FIELD_NAMES[field]).filter(Boolean);
  if (named.length === 0) return "";
  if (named.length === 1) return named[0];
  return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

/** Six hex characters. */
function noise(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
