/**
 * The six tabs of Account Settings, and how a URL maps onto one.
 *
 * Pure, and separate from the page, for two reasons. The routing is a
 * catch-all — `/settings`, `/settings/integrations`, and anything anybody types
 * or a stale bookmark points at — so "which tab is this" is a real decision with
 * a wrong answer (a blank page) that is easy to ship. And three older routes
 * still land here: `/privacy`, `/billing` and `/integrations` were pages before
 * they were tabs, and notifications written months ago still link to the first
 * of them.
 */

export type SettingsTab =
  | "general"
  | "meetings"
  | "plans"
  | "integrations"
  | "emails"
  | "security";

export interface TabSpec {
  id: SettingsTab;
  label: string;
}

/**
 * In the order they are shown.
 *
 * General first because it is where somebody lands, Security last because it is
 * where the irreversible things are and a tab bar is read left to right.
 */
export const SETTINGS_TABS: TabSpec[] = [
  { id: "general", label: "General" },
  { id: "meetings", label: "Meetings" },
  { id: "plans", label: "Plans" },
  { id: "integrations", label: "Integrations" },
  { id: "emails", label: "Emails" },
  { id: "security", label: "Security" },
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
  "/privacy": "security",
  "/billing": "plans",
  "/integrations": "integrations",
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
 * header is one that cannot help — and on the Integrations tab it sits directly
 * above a list of connections it does not search.
 *
 * <p>The legacy URLs count, and that is the whole reason this is a function
 * rather than a `startsWith` at the call site. `/integrations`, `/billing` and
 * `/privacy` render exactly the same component as `/settings/integrations` and
 * friends, so treating them differently would show the bar or hide it depending
 * on which link somebody happened to follow.
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
