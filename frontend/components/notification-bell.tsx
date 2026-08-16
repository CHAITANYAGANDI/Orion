"use client";

/**
 * The bell.
 *
 * <p>Everything Recallix does happens somewhere the user is not: an hour of
 * audio is transcribed while they are at lunch, a recap goes out overnight, a
 * link they shared is opened on Tuesday. Before this, the only feedback surface
 * was the live status socket on one meeting page — close the tab and the product
 * had nothing to say about the twenty minutes it spent working.
 *
 * <p><b>Two decisions worth writing down.</b>
 *
 * <p><i>Opening the panel does not mark everything read.</i> That is the common
 * shortcut and it destroys the only signal the list carries — somebody who
 * glances at the bell while waiting for a build would come back to find the
 * overdue task they meant to deal with indistinguishable from the nine things
 * they had already seen. Reading one marks that one; the rest is a button.
 *
 * <p><i>The socket only says "something changed".</i> The count and the words
 * come from the authenticated API. The STOMP topic is public, so a frame with a
 * meeting title in it would be a leak; see `NotificationPublisher` on the
 * server. The 90-second poll is what makes the socket an optimisation rather
 * than a dependency.
 */

import * as React from "react";
import Link from "next/link";
import {
  Bell,
  CheckCheck,
  Loader2,
  Mic,
  FileText,
  Sparkles,
  AlertTriangle,
  Mail,
  Clock,
  AlarmClock,
  AtSign,
  Eye,
  Trash2,
  X,
} from "lucide-react";
import {
  useGetNotificationsQuery,
  useGetUnreadCountQuery,
  useMarkNotificationReadMutation,
  useMarkAllNotificationsReadMutation,
  useDeleteNotificationMutation,
  useClearNotificationsMutation,
} from "@/lib/api";
import { subscribeNotifications } from "@/lib/ws";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { AppNotification, NotificationKind } from "@/lib/types";

/** How often to re-read the badge when the socket is not delivering. */
const POLL_MS = 90_000;

/** Above this, the badge stops counting and starts gesturing. */
const BADGE_MAX = 9;

const ICONS: Record<NotificationKind, React.ComponentType<{ className?: string }>> = {
  RECORDING_STARTED: Mic,
  PROCESSING_STARTED: Loader2,
  TRANSCRIPT_READY: FileText,
  SUMMARY_READY: Sparkles,
  PROCESSING_FAILED: AlertTriangle,
  RECAP_SENT: Mail,
  ACTION_ITEM_DUE: Clock,
  ACTION_ITEM_OVERDUE: AlarmClock,
  MENTIONED_IN_MEETING: AtSign,
  SHARE_VIEWED: Eye,
};

/** Relative, because "2h ago" is the only form anybody reads on a notification. */
export function ago(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function NotificationBell() {
  const [open, setOpen] = React.useState(false);
  const count = useGetUnreadCountQuery(undefined, { pollingInterval: POLL_MS });
  // Only fetched when the panel is open: fifty tabs polling a list nobody has
  // looked at is the cost of a bell that nobody asked to be expensive.
  const list = useGetNotificationsQuery({ size: 20 }, { skip: !open });

  const [markRead] = useMarkNotificationReadMutation();
  const [markAllRead, { isLoading: markingAll }] = useMarkAllNotificationsReadMutation();
  const [remove] = useDeleteNotificationMutation();
  const [clearAll, { isLoading: clearing }] = useClearNotificationsMutation();

  const channel = count.data?.channel;
  const refetchCount = count.refetch;
  const refetchList = list.refetch;

  React.useEffect(() => {
    if (!channel) return;
    const socket = subscribeNotifications(channel, () => {
      // Deliberately ignoring the number in the frame and re-reading: the
      // authenticated read is the one that is allowed to be believed.
      void refetchCount();
      void refetchList();
    });
    return () => socket.deactivate();
  }, [channel, refetchCount, refetchList]);

  const unread = count.data?.unread ?? 0;
  const items = list.data?.content ?? [];

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Bell className="h-5 w-5" />
          {unread > 0 && (
            <span
              className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground"
              aria-hidden
            >
              {unread > BADGE_MAX ? `${BADGE_MAX}+` : unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-medium">Notifications</span>
          <div className="flex items-center gap-1">
            {unread > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
                disabled={markingAll}
                onClick={() => void markAllRead()}
              >
                <CheckCheck className="h-3.5 w-3.5" /> Mark all read
              </Button>
            )}
            {items.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
                disabled={clearing}
                onClick={() => void clearAll()}
              >
                <Trash2 className="h-3.5 w-3.5" /> Clear
              </Button>
            )}
          </div>
        </div>

        <div className="max-h-[26rem] overflow-y-auto">
          {list.isLoading && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">Loading…</p>
          )}

          {!list.isLoading && items.length === 0 && (
            <div className="px-3 py-8 text-center">
              <p className="text-sm font-medium">Nothing yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Recallix will tell you here when a meeting is ready, when work falls
                due, and when a link you shared is opened.
              </p>
            </div>
          )}

          <ul>
            {items.map((n) => (
              <NotificationRow
                key={n.id}
                notification={n}
                onOpen={() => {
                  if (!n.read) void markRead({ id: n.id, read: true });
                  setOpen(false);
                }}
                onToggleRead={() => void markRead({ id: n.id, read: !n.read })}
                onDismiss={() => void remove(n.id)}
              />
            ))}
          </ul>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NotificationRow({
  notification: n,
  onOpen,
  onToggleRead,
  onDismiss,
}: {
  notification: AppNotification;
  onOpen: () => void;
  onToggleRead: () => void;
  onDismiss: () => void;
}) {
  const Icon = ICONS[n.kind] ?? Bell;
  const failed = n.kind === "PROCESSING_FAILED";

  const body = (
    <>
      <Icon
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          failed ? "text-destructive" : "text-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn("truncate text-sm", !n.read && "font-medium")}>{n.title}</span>
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
            {ago(n.createdAt)}
          </span>
        </span>
        {n.body && (
          <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{n.body}</span>
        )}
      </span>
    </>
  );

  return (
    <li
      className={cn(
        "group relative border-b border-border/60 last:border-b-0",
        !n.read && "bg-primary/[0.04]",
      )}
    >
      {n.link ? (
        <Link href={n.link} onClick={onOpen} className="flex gap-3 px-3 py-2.5 hover:bg-muted/60">
          {body}
        </Link>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full gap-3 px-3 py-2.5 text-left hover:bg-muted/60"
        >
          {body}
        </button>
      )}

      {/* Kept out of the link's hit area: clicking "dismiss" must not also
          navigate to the thing being dismissed. */}
      <span className="absolute right-1 top-1 hidden gap-0.5 group-hover:flex">
        <button
          type="button"
          onClick={onToggleRead}
          aria-label={n.read ? `Mark "${n.title}" unread` : `Mark "${n.title}" read`}
          className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
        >
          <CheckCheck className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Dismiss "${n.title}"`}
          className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
    </li>
  );
}
