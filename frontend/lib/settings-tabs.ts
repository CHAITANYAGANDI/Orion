/**
 * The seven tabs of Account Settings, and how a URL maps onto one.
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
  | "templates"
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
  { id: "templates", label: "Templates" },
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

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}
