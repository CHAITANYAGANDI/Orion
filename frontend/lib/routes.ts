/**
 * The paths this app uses, built and read in one place.
 *
 * <p>Two of them are here rather than inline because they are written by one
 * file and read by another, and a string that is constructed in six components
 * and parsed in a seventh is a rename waiting to break silently. Folders used
 * to be at /projects — the word the API still uses — and moving them meant
 * finding every literal by hand. This is so the next move is one file.
 *
 * <p>Nothing here touches the server. `/api/v1/projects` is unchanged and will
 * stay that way: the REST resource is a project row in a table, the page is a
 * folder, and renaming a database-facing route to match a piece of navigation
 * copy would be churn with a migration attached.
 */

/** Home, and the fallback for anywhere that cannot be returned to. */
export const HOME = "/home";

/** Every folder. */
export const FOLDERS = "/folders";

/** One folder. */
export function folderHref(id: string): string {
  return `/folder/${id}`;
}

/**
 * The folder a path is inside, or null.
 *
 * <p>Takes the path rather than the id because both callers have a path and
 * neither has an id: the header is rendered by the shell, which does not know
 * what page it is wrapping, and the recording knows only where Record was
 * pressed. Query and hash are trimmed, so a return path with search state on
 * it — /folder/prj_1?sort=name — still reads as that folder.
 */
export function folderIdFrom(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const parts = pathname.split(/[?#]/)[0].split("/").filter(Boolean);
  return parts.length === 2 && parts[0] === "folder" ? parts[1] : null;
}

/** The folder list itself, which is not a folder. */
export function isFolderListPath(pathname: string): boolean {
  return pathname === FOLDERS || pathname === `${FOLDERS}/`;
}

/** The page that exists to record. A prefix, so `/record/:id` cannot fall out. */
export function isRecordPath(pathname: string): boolean {
  return pathname === "/record" || pathname.startsWith("/record/");
}

/**
 * /record, carrying where it was pressed.
 *
 * <p>`?r=/folder/prj_1` rather than nothing, because two things need to know
 * where a recording came from and neither can work it out later. The meeting is
 * filed into that folder — by save time the pathname is /record, or wherever
 * the user wandered while the meeting ran, and "which folder am I in" has no
 * answer. And discarding goes back there, rather than to Home, which is not
 * where anybody was.
 *
 * <p>The session holds the same value (see lib/recording-context.tsx), and this
 * is not a second copy of it for its own sake: the session is memory, so a
 * reload of /record loses it, and the URL is what a reload, a bookmark or the
 * back button still has. Whichever arrives first wins and they agree, because
 * both are the pathname at the moment Record was pressed.
 */
export function recordHref(from: string): string {
  return `/record?r=${encodeURIComponent(returnPath(from))}`;
}

/**
 * Read `r` back, refusing anything that is not a page of this app.
 *
 * <p>It comes off the address bar, so it is untrusted input that ends up in
 * `router.push`. A `//evil.example` or a `/\evil.example` is a URL with a host
 * in it that looks like a path, and pushing one is an open redirect out of the
 * app — the ordinary way this parameter goes wrong. Anything unrecognised
 * becomes Home rather than an error: the recording is the thing that matters
 * here, and a mangled return path is not worth a dead end.
 *
 * <p>/record itself is refused too. Discarding a recording and being returned
 * to the page that opens a microphone on arrival would start another one.
 */
export function returnPath(raw: string | null | undefined): string {
  if (!raw) return HOME;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return HOME;
  if (isRecordPath(raw.split(/[?#]/)[0])) return HOME;
  return raw;
}
