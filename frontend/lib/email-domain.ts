/**
 * "Did you mean gmail.com?"
 *
 * <h2>Why a form that sends a code needs this and an ordinary form does not</h2>
 *
 * <p>A mistyped address in most forms is a mistake you find out about
 * immediately. A mistyped address in a <em>verification</em> form is a mistake
 * that looks like a broken product: the send succeeds, the screen says a code
 * is on its way, and nothing arrives — because it went to a domain one letter
 * away from the one that was meant. `gmaill.com` is a real place as far as the
 * mail system is concerned, and it is not your inbox.
 *
 * <p>So this is a hint and never a rule. It is offered beside the field, it can
 * be ignored, and it cannot refuse an address: plenty of real domains are one
 * letter from a famous one, and a form that argues with somebody about their
 * own address is worse than the typo it was guarding against.
 */

/**
 * The domains worth checking against.
 *
 * <p>Consumer mail, because that is where a personal address usually is and
 * where the near-misses cluster. A company domain has no famous neighbour to be
 * confused with, so leaving it off the list costs nothing.
 */
const KNOWN = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "zoho.com",
  "yandex.com",
  "mail.com",
];

/**
 * The address that was probably meant, or null if this one looks fine.
 *
 * <p>Only the domain is second-guessed. A local part is a name somebody chose
 * and there is nothing to compare it to.
 */
export function suggestAddress(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;

  const local = address.slice(0, at);
  const domain = address.slice(at + 1).toLowerCase();
  // Already one of them, or nothing like any of them.
  if (KNOWN.includes(domain)) return null;

  const meant = KNOWN.find((known) => oneEditApart(domain, known));
  return meant ? `${local}@${meant}` : null;
}

/**
 * Whether two strings are a single insertion, deletion, substitution or swap
 * apart.
 *
 * <p>The swap is not an extra: `gmial.com` is the commonest misspelling of the
 * commonest domain in the world, and it is two edits under the usual distance
 * — so a rule that left transposition out would miss the one case most worth
 * catching.
 */
function oneEditApart(a: string, b: string): boolean {
  if (a === b) return false;

  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (long.length - short.length > 1) return false;

  // Trim the matching head and the matching tail; whatever is left is the edit.
  let head = 0;
  while (head < short.length && short[head] === long[head]) head++;

  let tail = 0;
  while (
    tail < short.length - head &&
    short[short.length - 1 - tail] === long[long.length - 1 - tail]
  ) {
    tail++;
  }

  const shortRest = short.length - head - tail;
  const longRest = long.length - head - tail;
  if (shortRest <= 1 && longRest <= 1) return true;

  // Two characters left on each side, the same two the other way round.
  return (
    shortRest === 2 &&
    longRest === 2 &&
    short[head] === long[head + 1] &&
    short[head + 1] === long[head]
  );
}
