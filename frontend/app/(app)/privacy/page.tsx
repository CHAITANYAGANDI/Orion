"use client";

/**
 * Kept as a route, not redirected away.
 *
 * This was a page before it was a tab, and links to it are still out there —
 * most importantly in notification rows, which are a record of something that
 * happened and whose link column cannot be rewritten. `AccountSettings` reads
 * the tab from the pathname, so this renders the right one under its old URL.
 */

import { AccountSettings } from "@/components/settings/account-settings";

export default function Page() {
  return <AccountSettings />;
}
