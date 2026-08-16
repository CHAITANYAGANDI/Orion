"use client";

/**
 * Account Settings.
 *
 * One page with seven tabs, where there used to be four separate routes in
 * three different places — Settings in the sidebar, Billing in the sidebar,
 * Privacy in the sidebar, Integrations nowhere. That arrangement made every
 * "where do I change…" question a hunt, and put "close my account" and "which
 * summary template" at the same level of the navigation.
 *
 * The tab is in the URL rather than in state, so a tab can be linked to, opened
 * in a new window and bookmarked — which matters most for Security, the one
 * somebody is sent to by a notification about their own data.
 *
 * Each tab is its own component and fetches its own data. Nothing is loaded for
 * a tab that is not open: Templates costs a round trip to the AI service and
 * Security counts every row a workspace owns, and neither should be paid for by
 * somebody changing their recap address.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SETTINGS_TABS, pathForTab, tabFromPath, type SettingsTab } from "@/lib/settings-tabs";
import { GeneralTab } from "@/components/settings/general-tab";
import { MeetingsTab } from "@/components/settings/meetings-tab";
import { PlansTab } from "@/components/settings/plans-tab";
import { IntegrationsTab } from "@/components/settings/integrations-tab";
import { EmailsTab } from "@/components/settings/emails-tab";
import { TemplatesTab } from "@/components/settings/templates-tab";
import { SecurityTab } from "@/components/settings/security-tab";
import { cn } from "@/lib/utils";

export function AccountSettings() {
  const pathname = usePathname();
  const active = tabFromPath(pathname ?? "/settings");

  return (
    <div className="mx-auto w-full max-w-4xl">
      <h1 className="text-2xl font-semibold tracking-tight">Account Settings</h1>

      {/* Scrolls sideways rather than wrapping. Seven tabs wrapped onto two
          rows on a narrow window reads as two groups, and the grouping would be
          an accident of the viewport width. */}
      <nav
        aria-label="Account settings"
        className="mt-4 flex gap-1 overflow-x-auto border-b"
      >
        {SETTINGS_TABS.map((tab) => (
          <Link
            key={tab.id}
            href={pathForTab(tab.id)}
            aria-current={tab.id === active ? "page" : undefined}
            className={cn(
              "shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
              tab.id === active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      <div className="py-6">
        <TabBody tab={active} />
      </div>
    </div>
  );
}

function TabBody({ tab }: { tab: SettingsTab }) {
  switch (tab) {
    case "meetings":
      return <MeetingsTab />;
    case "plans":
      return <PlansTab />;
    case "integrations":
      return <IntegrationsTab />;
    case "emails":
      return <EmailsTab />;
    case "templates":
      return <TemplatesTab />;
    case "security":
      return <SecurityTab />;
    case "general":
    default:
      return <GeneralTab />;
  }
}
