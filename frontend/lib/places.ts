/**
 * The three places, and which one a pathname is in.
 *
 * <h2>Why this is a file and not a compare in the band</h2>
 *
 * <p>V2 has no navigation column. What replaces it is three words in a 48px
 * band, and the whole of "where am I" is carried by which of those three is
 * underlined — so the mapping from pathname to place is the navigation, not a
 * decoration on it. A `pathname === href` in the JSX gets that right for
 * exactly three URLs and wrong for every page underneath them.
 *
 * <p><strong>Nesting is the part that matters.</strong> A folder and a meeting
 * are inside Library; they are not Library. Underlining Library fully while
 * standing in a meeting claims you are on the Library page, and underlining
 * nothing at all is the failure the old rail did not have — an icon column
 * always showed *something* lit, and three words that all go quiet one level
 * down read as chrome that has stopped working. So a parent place gets a
 * dimmer rule: present, plainly not current. See components/v2/places.tsx.
 *
 * <p>Some paths are in no place, and that is a real answer rather than a gap.
 * /record, /settings, /welcome and /upload are things you are doing, not
 * somewhere you are, and each of them is left from a control of its own.
 */

import { ASK, FOLDERS, HOME, LIBRARY, folderIdFrom, isFolderListPath } from "@/lib/routes";

export { ASK, HOME, LIBRARY };

export type PlaceId = "now" | "library" | "ask";

export interface Place {
  /** Which of the three, or null where the path is in none of them. */
  id: PlaceId | null;
  /**
   * Whether this is a page *inside* the place rather than the place itself.
   *
   * <p>Drives the dimmer underline. Always false when `id` is null, so a caller
   * that only checks `nested` cannot mistake "nowhere" for "inside something".
   */
  nested: boolean;
}

const NOWHERE: Place = { id: null, nested: false };

/** Trim query and hash, so a return path with state on it still reads as its page. */
function bare(pathname: string | null | undefined): string {
  return (pathname ?? "").split(/[?#]/)[0];
}

/** One meeting. A prefix, so every id and sub-route lands in Library. */
function isMeetingPath(path: string): boolean {
  return path.startsWith("/meetings/");
}

/**
 * The place a pathname is in.
 *
 * <p>Ordered most specific first. The exact matches come before the prefix
 * ones, because /library is Library and /library/anything — if it ever exists —
 * is inside it, and a prefix test written first would collapse the two.
 */
export function placeFor(pathname: string | null | undefined): Place {
  const path = bare(pathname);
  if (!path) return NOWHERE;

  if (path === HOME || path === `${HOME}/`) return { id: "now", nested: false };
  if (path === LIBRARY || path === `${LIBRARY}/`) return { id: "library", nested: false };
  if (path === ASK || path === `${ASK}/`) return { id: "ask", nested: false };

  // Inside Library: the folder list, one folder, one meeting. /folders is here
  // rather than being its own place because Library is where folders live now;
  // it is kept as a URL so existing links and bookmarks still land somewhere
  // sensible. See docs/v2-implementation/feature-parity.md.
  if (isFolderListPath(path) || folderIdFrom(path) !== null || isMeetingPath(path)) {
    return { id: "library", nested: true };
  }
  if (path.startsWith(`${ASK}/`)) return { id: "ask", nested: true };
  if (path.startsWith(`${LIBRARY}/`) || path.startsWith(`${FOLDERS}/`)) {
    return { id: "library", nested: true };
  }

  return NOWHERE;
}
