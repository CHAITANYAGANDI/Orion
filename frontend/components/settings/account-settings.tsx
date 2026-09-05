"use client";

/**
 * Account Settings.
 *
 * One page, two tabs. There used to be several separate routes in three
 * different places — Settings in the sidebar, Billing in the sidebar, Privacy
 * in the sidebar — which made every "where do I change…" question a hunt.
 * Four of the six tabs that replaced them have since gone with the features
 * they configured.
 *
 * The tab is in the URL rather than in state, so a tab can be linked to, opened
 * in a new window and bookmarked.
 *
 * There is no Templates tab. A summary template is chosen per meeting — on the
 * upload page as a recording arrives, and from a meeting's own summary
 * afterwards — so a settings tab about them was a read-only catalogue sitting
 * one click from where the choice is never made.
 *
 * Each tab is its own component and fetches its own data. Nothing is loaded for
 * a tab that is not open: Plans reads usage, and that should not be paid for by
 * somebody changing their name.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SETTINGS_TABS, pathForTab, tabFromPath, type SettingsTab } from "@/lib/settings-tabs";
import { GeneralTab } from "@/components/settings/general-tab";
import { PlansTab } from "@/components/settings/plans-tab";
import { cn } from "@/lib/utils";

export function AccountSettings() {
  const pathname = usePathname();
  const active = tabFromPath(pathname ?? "/settings");

  return (
    /* A preferences document, set in the measure like every other document
       in the product. It was 4xl (896px), which is a dashboard width — and
       these are single-column sections of prose and switches, so the extra
       216px was spent making each line harder to read. */
    <div className="mx-auto w-full max-w-measure">
      <h1 className="text-title-l font-headline text-ink">Account Settings</h1>

      {/* Scrolls sideways rather than wrapping. Tabs wrapped onto two rows on
          a narrow window read as two groups, and the grouping would be an
          accident of the viewport width. */}
      {/* The same device the meeting's reading modes use and the band uses
          for its places: a word, and a 2px ink rule on a boundary the layout
          already has. Three underlines in the product, one idea.

          Scrolls sideways rather than wrapping. Tabs wrapped onto two rows on
          a narrow window read as two groups, and the grouping would be an
          accident of the viewport width. */}
      <nav
        aria-label="Account settings"
        className="no-scrollbar mt-5 flex gap-6 overflow-x-auto border-b border-line"
      >
        {SETTINGS_TABS.map((tab) => (
          <Link
            key={tab.id}
            href={pathForTab(tab.id)}
            aria-current={tab.id === active ? "page" : undefined}
            className={cn(
              "-mb-px shrink-0 border-b-2 px-0 pb-2.5 pt-1 text-callout transition-colors",
              tab.id === active
                ? "border-ink font-headline text-ink"
                : "border-transparent text-ink-3 hover:text-ink-2",
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      <div className="py-7">
        <TabBody tab={active} />
      </div>
    </div>
  );
}

function TabBody({ tab }: { tab: SettingsTab }) {
  switch (tab) {
    case "plans":
      return <PlansTab />;
    case "general":
    default:
      return <GeneralTab />;
  }
}
