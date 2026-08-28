"use client";

/**
 * The last few things somebody searched for.
 *
 * <p>Kept in this browser, not on the server. Orion has no search-history
 * endpoint, and inventing one to hold a handful of strings would put every
 * query anybody types into the database — a record of what people went looking
 * for, which is a more sensitive thing to keep than it first sounds and which
 * nothing in the product would read. This is a convenience, so it lives where
 * conveniences belong: on the machine that wanted it.
 *
 * <p>The consequence, stated rather than hidden: history does not follow you to
 * another browser, and clearing site data clears it.
 *
 * <p>Stored per user id. Two accounts on one machine — which is the ordinary
 * case in development, and happens on shared laptops — must not be able to read
 * each other's searches back out of a shared list.
 */

const PREFIX = "orion.recent-searches";

/** Enough to be useful, few enough that the newest is never pushed off screen. */
export const MAX_RECENT = 5;

function keyFor(userId: string | null | undefined): string {
  return `${PREFIX}.${userId || "anon"}`;
}

/** Every stored search for this user, newest first. */
export function readRecentSearches(userId: string | null | undefined): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Filtered rather than trusted: this is user-writable storage, and one
    // hand-edited entry should not be able to put a non-string into a list the
    // UI maps over.
    return parsed.filter((v): v is string => typeof v === "string" && v.trim() !== "").slice(0, MAX_RECENT);
  } catch {
    // Private browsing, a full quota, or a value somebody edited by hand. None
    // of them is a reason to be unable to search.
    return [];
  }
}

/**
 * Record a search, newest first, without duplicating one already there.
 *
 * <p>Compared case-insensitively on the trimmed text, so searching "Stripe"
 * after "stripe" moves the existing entry up rather than adding a second one
 * that looks identical in the list.
 */
export function rememberSearch(userId: string | null | undefined, query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return readRecentSearches(userId);

  const existing = readRecentSearches(userId).filter(
    (q) => q.toLowerCase() !== trimmed.toLowerCase(),
  );
  const next = [trimmed, ...existing].slice(0, MAX_RECENT);

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(keyFor(userId), JSON.stringify(next));
    } catch {
      /* Storage unavailable or full. The search itself still runs. */
    }
  }
  return next;
}

/** Forget everything, for the button that says so. */
export function clearRecentSearches(userId: string | null | undefined): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(keyFor(userId));
  } catch {
    /* Nothing to do about it, and nothing depends on it. */
  }
}
