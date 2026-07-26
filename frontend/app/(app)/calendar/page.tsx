"use client";

/**
 * Upcoming meetings, read from subscribed iCal feeds.
 *
 * The point of this page is the "Record" button next to each meeting: it opens
 * the recorder with the title already filled in, which is the whole gap between
 * Recallix and a product that sends a bot to the call for you.
 */

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  CalendarDays,
  Loader2,
  Plus,
  Trash2,
  Video,
  Mic,
  AlertTriangle,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import {
  useGetCalendarsQuery,
  useSubscribeCalendarMutation,
  useUnsubscribeCalendarMutation,
  useGetCalendarEventsQuery,
} from "@/lib/api";
import type { CalendarEventResponse } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

export default function CalendarPage() {
  const calendars = useGetCalendarsQuery();
  const events = useGetCalendarEventsQuery(7);
  const [subscribe, { isLoading: subscribing }] = useSubscribeCalendarMutation();
  const [unsubscribe] = useUnsubscribeCalendarMutation();

  const [url, setUrl] = React.useState("");
  const [label, setLabel] = React.useState("");

  async function onSubscribe(e: React.FormEvent) {
    e.preventDefault();
    try {
      await subscribe({ url: url.trim(), label: label.trim() || undefined }).unwrap();
      setUrl("");
      setLabel("");
      toast.success("Calendar connected.");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function onRemove(id: string) {
    try {
      await unsubscribe(id).unwrap();
      toast.success("Calendar removed.");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const connected = calendars.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Calendar</h1>
        <p className="text-sm text-muted-foreground">
          Connect a calendar to see what&apos;s coming up and start recording in one click.
        </p>
      </div>

      {/* Upcoming meetings */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarDays className="h-4 w-4 text-primary" /> Next 7 days
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => events.refetch()}
            disabled={events.isFetching}
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${events.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {events.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : connected.length === 0 ? (
            <EmptyState />
          ) : (events.data ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing scheduled in the next 7 days.
            </p>
          ) : (
            <ul className="divide-y">
              {(events.data ?? []).map((e, i) => (
                <EventRow key={`${e.uid ?? "evt"}-${e.start}-${i}`} event={e} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Connected calendars */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Connected calendars</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {connected.length > 0 && (
            <ul className="divide-y">
              {connected.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{c.label || c.redactedUrl}</p>
                    <p className="text-xs text-muted-foreground">
                      {c.redactedUrl}
                      {c.lastSyncedAt && ` · synced ${new Date(c.lastSyncedAt).toLocaleString()}`}
                      {` · ${c.eventCount} event${c.eventCount === 1 ? "" : "s"}`}
                    </p>
                    {c.lastError && (
                      <p className="mt-1 flex items-start gap-1 text-xs text-destructive">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        {c.lastError}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onRemove(c.id)}
                    aria-label={`Remove ${c.label ?? "calendar"}`}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={onSubscribe} className="space-y-3 border-t pt-4">
            <div className="grid gap-2">
              <Label htmlFor="ical-url">iCal / ICS address</Label>
              <Input
                id="ical-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
                disabled={subscribing}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ical-label">Label (optional)</Label>
              <Input
                id="ical-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Work"
                disabled={subscribing}
              />
            </div>
            <Button type="submit" disabled={subscribing || !url.trim()} className="gap-2">
              {subscribing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Connect calendar
            </Button>
            <p className="text-xs text-muted-foreground">
              Read-only. Recallix never writes to your calendar, and the address is
              stored server-side and never shown again.
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function EventRow({ event }: { event: CalendarEventResponse }) {
  const start = new Date(event.start);
  const soon = start.getTime() - Date.now() < 15 * 60 * 1000 && start.getTime() > Date.now() - 3600_000;

  // Carry the title into the recorder so the meeting is named before it starts.
  const recordHref = `/record?title=${encodeURIComponent(event.title)}`;

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate font-medium">{event.title}</p>
          {soon && <Badge>Starting soon</Badge>}
          {event.calendarLabel && <Badge variant="secondary">{event.calendarLabel}</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">
          {event.allDay ? formatDay(start) : formatWhen(start, new Date(event.end))}
          {event.location && !event.meetingUrl && ` · ${event.location}`}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {event.meetingUrl && (
          <Button variant="outline" size="sm" asChild className="gap-2">
            <a href={event.meetingUrl} target="_blank" rel="noreferrer noopener">
              <Video className="h-4 w-4" /> Join
              <ExternalLink className="h-3 w-3" />
            </a>
          </Button>
        )}
        <Button size="sm" asChild className="gap-2">
          <Link href={recordHref}>
            <Mic className="h-4 w-4" /> Record
          </Link>
        </Button>
      </div>
    </li>
  );
}

function EmptyState() {
  return (
    <div className="space-y-3 py-6 text-center">
      <CalendarDays className="mx-auto h-8 w-8 text-muted-foreground" />
      <p className="font-medium">No calendar connected yet</p>
      <div className="mx-auto max-w-md text-left text-sm text-muted-foreground">
        <p className="mb-2">Grab your calendar&apos;s private address:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Google Calendar</strong> — Settings → your calendar → “Secret address in iCal format”
          </li>
          <li>
            <strong>Outlook</strong> — Settings → Calendar → Shared calendars → Publish, then copy the ICS link
          </li>
          <li>
            <strong>Apple Calendar</strong> — right-click the calendar → Share → Public Calendar
          </li>
        </ul>
      </div>
    </div>
  );
}

function formatWhen(start: Date, end: Date): string {
  const day = formatDay(start);
  const time = `${start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}–${end.toLocaleTimeString(
    [],
    { hour: "numeric", minute: "2-digit" }
  )}`;
  return `${day} · ${time}`;
}

function formatDay(d: Date): string {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function errorMessage(err: unknown): string {
  if (typeof err === "object" && err && "data" in err) {
    const data = (err as { data?: { message?: string } }).data;
    if (data?.message) return data.message;
  }
  return "Something went wrong";
}
