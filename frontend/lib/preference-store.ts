/**
 * Choices that outlive the page, but not the sign-in.
 *
 * <p>A filter set on Home used to last until you navigated away from it, which
 * made every visit start over — you narrowed the list to last week, opened a
 * meeting, came back, and it was showing everything again. So the choice is
 * written down.
 *
 * <p><b>And unwritten at the door.</b> Signing out has to put the filters back
 * to their defaults, which is what makes this a store rather than a
 * `localStorage.setItem`. Two things enforce it, because either alone has a
 * hole:
 *
 * <ol>
 *   <li><b>Every entry is stamped with the sign-in it was made under</b>, and a
 *       read under a different one returns nothing. That covers the cases
 *       nobody calls `signOut` for — a session that expired, a sign-out in
 *       another tab, a second person on the same browser — and it covers them
 *       whether or not this code ever ran.</li>
 *   <li><b>`clearPreferences` on the way out</b>, because a sign-in is not
 *       always a new stamp. Dev mode has one user id and reuses it, so signing
 *       out and back in there produces the same key; and leaving one account's
 *       choices on disk for the next person to sign in is not something to do
 *       merely because they would have been ignored.</li>
 * </ol>
 *
 * <p>No React in this file on purpose: lib/auth.tsx calls `clearPreferences`,
 * and the hook in lib/preferences.ts calls `useAuth`. Split in two so that is a
 * line rather than a circle.
 *
 * <p>Nothing here is load-bearing. Storage throws in a private window and is
 * absent during SSR, and a filter that quietly stops being remembered is a
 * smaller problem than a page that will not render — so every path swallows and
 * falls back to the default.
 */

const KEY = "recallix.prefs";

interface Stored {
  /** Identifies the sign-in these were chosen under. */
  session: string;
  values: Record<string, unknown>;
}

function read(): Stored | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (typeof parsed?.session !== "string" || !parsed.values || typeof parsed.values !== "object") {
      return null;
    }
    return { session: parsed.session, values: parsed.values as Record<string, unknown> };
  } catch {
    // Unparseable, or storage is unavailable. Either way there is nothing to
    // restore, which is a state this already has a name for.
    return null;
  }
}

/**
 * Everything remembered under this sign-in, or nothing.
 *
 * <p>A stamp that does not match is not an error and is not repaired here: the
 * entry is left alone until something is actually written, so that opening the
 * app while signed out cannot destroy what a signed-in tab is still using.
 */
export function readPreferences(session: string): Record<string, unknown> {
  if (!session) return {};
  const stored = read();
  return stored && stored.session === session ? stored.values : {};
}

/** Remember one choice. Replaces the whole record if the sign-in has changed. */
export function writePreference(session: string, name: string, value: unknown): void {
  if (typeof window === "undefined" || !session) return;
  const stored = read();
  const values = stored && stored.session === session ? { ...stored.values } : {};
  if (value === undefined || value === null) {
    delete values[name];
  } else {
    values[name] = value;
  }
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ session, values } satisfies Stored));
  } catch {
    // Quota, or a private window. The choice still applies for this visit; it
    // just will not survive the next one.
  }
}

/** Forget everything. Called on the way out — see the note at the top. */
export function clearPreferences(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
