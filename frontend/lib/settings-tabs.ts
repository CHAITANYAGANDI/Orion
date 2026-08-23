/**
 * The two tabs of Account Settings, and how a URL maps onto one.
 *
 * Pure, and separate from the page, for two reasons. The routing is a
 * catch-all — `/settings`, `/settings/security`, and anything anybody types
 * or a stale bookmark points at — so "which tab is this" is a real decision with
 * a wrong answer (a blank page) that is easy to ship. And two older routes
 * still land here: `/privacy` and `/billing` were pages before they were tabs,
 * and notifications written months ago still link to the first of them.
 *
 * There were six. Integrations held a calendar feed that no longer exists.
 * Meetings held sharing defaults, a chat window, and custom vocabulary and
 * known speakers; sharing and both transcription lists are gone, and the chat
 * window is now settable only through the API. Emails held seven switches and
 * Security showed sign-in facts and a privacy inventory — of which the
 * retention dials and the close-account control are now on General, because
 * they delete things and a control that deletes things should be reachable.
 *
 * <p>None of the removed URLs is special-cased on the way out. They fall to
 * General like any other unrecognised settings path, which is the behaviour a
 * stale bookmark wants: a settings URL somebody saved should show them
 * settings, not a blank pane that reads as a page which failed to load.
 */

export type SettingsTab = "general" | "plans";

export interface TabSpec {
  id: SettingsTab;
  label: string;
}

/**
 * In the order they are shown.
 *
 * General first because it is where somebody lands.
 */
export const SETTINGS_TABS: TabSpec[] = [
  { id: "general", label: "General" },
  { id: "plans", label: "Plans" },
];

export const DEFAULT_TAB: SettingsTab = "general";

/**
 * Where the pages that used to exist now live.
 *
 * Kept rather than redirected away and forgotten: `RETENTION_APPLIED`
 * notifications written before this restructuring carry `/privacy` in their
 * link column, and those rows are a record of something that happened. The link
 * has to keep working for as long as they do.
 */
export const LEGACY_PATHS: Record<string, SettingsTab> = {
  // Security is gone, so this lands on General rather than nowhere. The row it
  // is written into is still a record of something that happened, and a link
  // that 404s is a worse answer than the settings page.
  "/privacy": "general",
  "/billing": "plans",
};

/**
 * Read a pathname as a tab.
 *
 * Anything unrecognised falls to General rather than rendering nothing. A
 * settings URL somebody mistyped should show them settings, not a blank pane
 * that looks like the page failed to load.
 */
export function tabFromPath(pathname: string): SettingsTab {
  const legacy = LEGACY_PATHS[stripTrailingSlash(pathname)];
  if (legacy) return legacy;

  const segments = stripTrailingSlash(pathname).split("/").filter(Boolean);
  const last = segments[segments.length - 1]?.toLowerCase();
  const match = SETTINGS_TABS.find((t) => t.id === last);
  return match ? match.id : DEFAULT_TAB;
}

/** The canonical URL for a tab, which is what the tab bar navigates to. */
export function pathForTab(tab: SettingsTab): string {
  return `/settings/${tab}`;
}

/**
 * Whether this URL is the account settings page, under any of its names.
 *
 * <p>Exists so the shell can drop the search bar here. Searching is for finding
 * a meeting; nothing on these pages is a meeting, so the widest control in the
 * header is one that cannot help.
 *
 * <p>The legacy URLs count, and that is the whole reason this is a function
 * rather than a `startsWith` at the call site. `/billing` and `/privacy` render
 * the same component as `/settings/plans` and `/settings/general`, so treating
 * them differently would show the bar or hide it depending on which link
 * somebody happened to follow.
 *
 * <p>`hasOwnProperty` rather than `in`: a pathname of `/toString` is reachable
 * by typing it, and `in` would say yes.
 */
export function isSettingsPath(pathname: string): boolean {
  const path = stripTrailingSlash(pathname);
  return (
    path === "/settings" ||
    path.startsWith("/settings/") ||
    Object.prototype.hasOwnProperty.call(LEGACY_PATHS, path)
  );
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}
