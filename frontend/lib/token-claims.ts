/**
 * Whose credential is this, according to the credential?
 *
 * <h2>Why the app reads its own token</h2>
 *
 * <p>Because asking for a token and being handed one are not the same as being
 * handed <em>this session's</em> token, and until now nothing checked.
 * `getToken()` is a cache with a network call behind it: it keeps the last JWT
 * it minted and returns it until it is close to expiry. Across a sign-out and a
 * sign-in that cache can still be holding the previous session's token, and a
 * Clerk JWT is not revoked when a session ends — it is simply short-lived. So
 * it verifies, the API accepts it, and the answer that comes back describes
 * whoever the <em>previous</em> session belonged to.
 *
 * <p>Which is a wrong answer that looks exactly like a right one. An account
 * with nothing in it returns an empty meeting list, an empty folder list, and
 * 404 for a meeting id that belongs to somebody else — all of them 200s and a
 * legitimate 404, none of them errors, every one of them rendered as fact. Then
 * the stale token expires a minute later and the same page starts failing
 * outright. A reload fixes it because a reload throws that cache away.
 *
 * <p>So: read the `sid` claim, compare it with the session the app is actually
 * open for, and refuse to send anything that names a different one. This is a
 * tenant-isolation rule as much as a loading-state one — the failure it
 * prevents is one account's screen filled with another account's data.
 *
 * <h2>Reading, not verifying</h2>
 *
 * <p>Nothing here is a security check on the token's contents. The signature is
 * the server's business and this cannot and does not test it: a forged payload
 * would be rejected by the API regardless. All this decides is whether the
 * credential the SDK just handed us is the one we asked for, and the only
 * honest answer to a token we cannot parse is "it does not say".
 */

/** What the payload claims, as far as this matters. Null means it did not say. */
export interface TokenClaims {
  /** Clerk's session id — `sess_...`. */
  sid: string | null;
  /** The subject: the Clerk user id. */
  sub: string | null;
}

const NOTHING: TokenClaims = { sid: null, sub: null };

/**
 * The claims a JWT carries, or nulls for anything that is not one.
 *
 * <p>Total: every malformed input — the empty string, two segments, base64 that
 * is not base64, a payload that is valid JSON but not an object — answers
 * "it does not say" rather than throwing. A credential check that can throw
 * would turn a strange token into a blank screen, and this runs in front of
 * every request the app makes.
 */
export function readTokenClaims(token: string): TokenClaims {
  const payload = token.split(".")[1];
  if (!payload) return NOTHING;

  try {
    const json = decodeSegment(payload);
    const claims: unknown = JSON.parse(json);
    if (typeof claims !== "object" || claims === null) return NOTHING;
    const record = claims as Record<string, unknown>;
    return { sid: stringClaim(record.sid), sub: stringClaim(record.sub) };
  } catch {
    return NOTHING;
  }
}

/**
 * Whether a token may be sent on behalf of `sessionId`.
 *
 * <p>Permissive in exactly one direction, and deliberately. A token that names
 * no session cannot be proven to belong to somebody else, and a JWT template
 * that omits `sid` is a supported way to configure Clerk — refusing those would
 * turn a configuration choice into an application that never loads. A token
 * that names a <em>different</em> session has proven itself, and is refused.
 */
export function tokenBelongsTo(token: string, sessionId: string): boolean {
  const { sid } = readTokenClaims(token);
  return sid === null || sid === sessionId;
}

function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * base64url → text.
 *
 * <p>`atob` wants base64 with padding; JWT segments are base64url without it.
 * The bytes are decoded as UTF-8 rather than read as latin-1, because a claim
 * with a non-ASCII character would otherwise come out mangled and take the
 * whole payload down with it through `JSON.parse`.
 */
function decodeSegment(segment: string): string {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
