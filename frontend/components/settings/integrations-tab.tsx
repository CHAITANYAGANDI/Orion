"use client";

/**
 * Integrations.
 *
 * One that works, and an honest account of what does not. That ratio is
 * deliberate: an integrations page is usually a wall of logos with "Connect"
 * buttons behind half of which nothing happens, and a reader learns from it only
 * that somebody drew the logos.
 *
 * The one that works is a calendar feed of your action item deadlines. It needs
 * no OAuth client, no provider review and no stored third-party credential —
 * every calendar application subscribes to an ICS URL — and it puts deadlines
 * where somebody already looks, which the daily digest email cannot.
 */

import * as React from "react";
import { toast } from "sonner";
import {
  Plug,
  CalendarDays,
  Copy,
  Check,
  RefreshCw,
  Loader2,
  Trash2,
  Bot,
  Mail,
  Link2,
  Download,
} from "lucide-react";
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
      <p className="text-sm text-muted-foreground">
        What Recallix connects to, and what it deliberately does not.
      </p>

      <section>
        <h2 className="mb-3 text-lg font-semibold">My Integrations</h2>
        <CalendarCard />
      </section>

      {/* Where a competitor puts "Discover" — a grid of logos with Connect
          buttons behind half of which nothing happens. These two sections are
          the same information without the pretence: what is genuinely wired up,
          and what is not and why. A logo somebody cannot use teaches them only
          that it was drawn. */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Also connected</h2>
        <AlreadyConnected />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Not available</h2>
        <NotConnected />
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

/**
 * The things that already work and are never called integrations.
 *
 * Worth listing, because "what does this connect to" is usually answered with a
 * shorter list than the truth: email, published links and file export are all
 * ways data leaves Recallix, and somebody auditing that should find them here
 * rather than in three different settings pages.
 */
function AlreadyConnected() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Ways your data already leaves Recallix</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <Row
          icon={<Mail className="h-4 w-4" />}
          title="Email"
          body="Recaps when a meeting finishes, and a daily digest of deadlines. Both opt-in, in Settings."
        />
        <Row
          icon={<Link2 className="h-4 w-4" />}
          title="Share links"
          body="Any meeting can be published as a read-only link, with a password and an expiry. Every live one is listed under Privacy & data."
        />
        <Row
          icon={<Download className="h-4 w-4" />}
          title="Export"
          body="A meeting as PDF, Word, Markdown or text; the whole account as a zip with JSON another system can read."
        />
      </CardContent>
    </Card>
  );
}

/**
 * What is not here, and why — the half of this page that is usually missing.
 *
 * The bot line matters most. Every competitor's integrations page implies a bot
 * that joins your calls, and a reader who assumes Recallix has one will wait for
 * meetings to record themselves.
 */
function NotConnected() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Not connected, and why</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <Row
          icon={<Bot className="h-4 w-4" />}
          title="No meeting bot"
          body="Recallix never joins a Zoom, Meet or Teams call and never appears in a participant list. Recording happens in your own browser tab, which is why nothing here can start it for you."
          muted
        />
        <Row
          icon={<CalendarDays className="h-4 w-4" />}
          title="Reading your calendar"
          body="Nothing useful follows from a list of meetings we cannot join, so it is not built. The feed above is the other direction, and that one earns its keep."
          muted
        />
        <Row
          icon={<Plug className="h-4 w-4" />}
          title="Slack, Notion, CRMs"
          body="None of these are wired up. When one is, it will appear above with a URL you can test — not as a logo with a disabled button."
          muted
        />
      </CardContent>
    </Card>
  );
}

function Row({
  icon,
  title,
  body,
  muted = false,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className={muted ? "mt-0.5 text-muted-foreground" : "mt-0.5 text-primary"}>
        {icon}
      </span>
      <span>
        <span className="block font-medium">{title}</span>
        <span className="block text-muted-foreground">{body}</span>
      </span>
    </div>
  );
}
