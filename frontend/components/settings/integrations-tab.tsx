"use client";

/**
 * Integrations.
 *
 * One, and it works: a calendar feed of your action item deadlines. It needs no
 * OAuth client, no provider review and no stored third-party credential — every
 * calendar application subscribes to an ICS URL — and it puts deadlines where
 * somebody already looks, which the daily digest email cannot.
 *
 * <p>Two lists used to sit under it. "Also connected" restated email, share
 * links and export — real things, each already documented on the settings page
 * that owns it — and "Not available" explained the meeting bot, calendar
 * reading and Slack that Recallix does not have. Both were written against an
 * integrations page that is usually a wall of logos with dead Connect buttons,
 * and both answered that with more prose than the one working integration got.
 * Somebody opening this tab is looking for the feed.
 */

import * as React from "react";
import { toast } from "sonner";
import { CalendarDays, Copy, Check, RefreshCw, Loader2, Trash2 } from "lucide-react";
import {
  useGetCalendarFeedQuery,
  useEnableCalendarFeedMutation,
  useDisableCalendarFeedMutation,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/format";

export function IntegrationsTab() {
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">What Recallix connects to.</p>

      <section>
        <h2 className="mb-3 text-lg font-semibold">My Integrations</h2>
        <CalendarCard />
      </section>
    </div>
  );
}

/**
 * The calendar feed.
 *
 * Two URLs for one feed, because the two ways of subscribing want different
 * forms: desktop calendars follow `webcal://` from a click, and Google's web UI
 * wants an `https://` address pasted into a box. Offering only one means half
 * the users have to know to edit it.
 */
function CalendarCard() {
  const { data, isLoading } = useGetCalendarFeedQuery();
  const [enable, { isLoading: enabling }] = useEnableCalendarFeedMutation();
  const [disable, { isLoading: disabling }] = useDisableCalendarFeedMutation();
  const [copied, setCopied] = React.useState(false);

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy — select the URL instead.");
    }
  }

  async function create() {
    try {
      await enable().unwrap();
      toast.success("Calendar feed ready.");
    } catch {
      toast.error("Couldn't create the feed.");
    }
  }

  async function rotate() {
    if (
      !window.confirm(
        "Generate a new URL?\n\nEvery calendar already subscribed to the old one " +
          "stops updating. That is what makes this the revoke button.",
      )
    ) {
      return;
    }
    try {
      await enable().unwrap();
      toast.success("New URL generated. Re-subscribe with the new one.");
    } catch {
      toast.error("Couldn't regenerate the URL.");
    }
  }

  async function turnOff() {
    if (!window.confirm("Turn the feed off? Every calendar subscribed to it stops working.")) {
      return;
    }
    try {
      await disable().unwrap();
      toast.success("Feed turned off.");
    } catch {
      toast.error("Couldn't turn it off.");
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarDays className="h-4 w-4 text-primary" /> Your calendar
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Publishes every action item with a deadline as an all-day event, in
          Google Calendar, Outlook, Apple Calendar or anything else that
          subscribes to a URL. Read-only, one way: Recallix never writes to your
          calendar and never reads it.
        </p>

        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : data?.enabled && data.url ? (
          <div className="space-y-3">
            <div className="rounded-md border bg-muted/40 p-3">
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                Subscription URL
              </p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate text-xs">{data.url}</code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={() => void copy(data.url!)}
                  aria-label="Copy the subscription URL"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              {data.deadlines === 0
                ? "Nothing has a deadline yet, so the calendar is empty. It fills in as action items get dates."
                : `Publishing ${data.deadlines} deadline${data.deadlines === 1 ? "" : "s"}.`}
              {data.createdAt ? ` Created ${formatDate(data.createdAt)}.` : ""}
            </p>

            {/* Said next to the button rather than after it. "Regenerate" sounds
                harmless and is the act that breaks every calendar subscribed. */}
            <p className="text-xs text-muted-foreground">
              Anyone with this URL can read your deadlines — it is the only
              credential a calendar server can present. Treat it like a password,
              and regenerate it if it gets out.
            </p>

            <div className="flex flex-wrap gap-2">
              {data.webcalUrl && (
                <Button variant="outline" size="sm" asChild>
                  <a href={data.webcalUrl}>
                    <CalendarDays className="mr-2 h-4 w-4" /> Subscribe now
                  </a>
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => void rotate()} disabled={enabling}>
                {enabling ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Generate a new URL
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => void turnOff()}
                disabled={disabling}
              >
                <Trash2 className="mr-2 h-4 w-4" /> Turn off
              </Button>
            </div>
          </div>
        ) : (
          <Button onClick={() => void create()} disabled={enabling}>
            {enabling ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <CalendarDays className="mr-2 h-4 w-4" />
            )}
            Create the feed
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
