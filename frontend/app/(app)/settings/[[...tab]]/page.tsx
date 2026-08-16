"use client";

/**
 * `/settings`, and `/settings/<tab>` for each of the seven.
 *
 * An optional catch-all so the bare path and every tab are one route. The tab
 * is read from the pathname inside `AccountSettings`, which is also what lets
 * `/privacy`, `/billing` and `/integrations` render the right tab without a
 * redirect that would change a URL somebody bookmarked.
 */

import { AccountSettings } from "@/components/settings/account-settings";

export default function SettingsPage() {
  return <AccountSettings />;
}
