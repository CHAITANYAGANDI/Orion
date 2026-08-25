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
 *
 * <p><b>Inbox and Unread are two queries, not one list filtered twice.</b> The
 * panel holds twenty rows; somebody with sixty notifications and four unread
 * would otherwise open Unread and see whichever of the four happened to fall
 * inside the most recent twenty. `GET /notifications?unread=true` filters in the
 * database, so the tab means what it says however long the archive is.
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
import { groupByDay } from "@/lib/days";
import type { AppNotification, NotificationKind } from "@/lib/types";

/** How often to re-read the badge when the socket is not delivering. */
const POLL_MS = 90_000;

/** Above this, the badge stops counting and starts gesturing. */
const BADGE_MAX = 9;

/** How many rows the panel holds. Beyond this it says so rather than pretending. */
const PAGE_SIZE = 20;

/** Everything, or only what has not been read. */
type Filter = "inbox" | "unread";

const ICONS: Record<NotificationKind, React.ComponentType<{ className?: string }>> = {
  RECORDING_STARTED: Mic,
  PROCESSING_STARTED: Loader2,
  TRANSCRIPT_READY: FileText,
  SUMMARY_READY: Sparkles,
  PROCESSING_FAILED: AlertTriangle,
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

export function NotificationBell({ onNavigate }: { onNavigate?: () => void } = {}) {
  const [open, setOpen] = React.useState(false);
  const [filter, setFilter] = React.useState<Filter>("inbox");
  const count = useGetUnreadCountQuery(undefined, { pollingInterval: POLL_MS });
  // Only fetched when the panel is open: fifty tabs polling a list nobody has
  // looked at is the cost of a bell that nobody asked to be expensive.
  const list = useGetNotificationsQuery(
    { size: PAGE_SIZE, unread: filter === "unread" },
    { skip: !open },
  );

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
  const items = React.useMemo(() => list.data?.content ?? [], [list.data]);
  const total = list.data?.totalElements ?? items.length;
  // The clock is read once per render of the panel rather than per row, so a
  // list open across midnight cannot put two notifications from the same
  // evening under "Today" and "Yesterday".
  const groups = React.useMemo(() => groupByDay(items), [items]);

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Back to Inbox on close. Marking everything read leaves Unread empty,
        // and a bell that opens onto "You're all caught up" the next morning
        // reads as one that has stopped working.
        if (!next) setFilter("inbox");
      }}
    >
      {/* An icon in the wordmark row, not a row of its own.
          There is no width for a written label beside "Recallix", so the name
          lives in aria-label and in the tooltip and the count goes back to the
          corner of the icon. That is the cost of the move, and it is paid
          knowingly: the row it left was below the fold on a short window with a
          few folders open, and a bell nobody scrolls to is a bell that does not
          work. The number is kept rather than reduced to a dot — "3" and "9+"
          are different amounts of reason to stop what you are doing. */}
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
          title="Notifications"
          className={cn(
            "relative ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors",
            open || unread > 0 ? "text-foreground" : "text-muted-foreground",
            "hover:bg-accent hover:text-accent-foreground",
            open && "bg-accent",
          )}
        >
          <Bell className="h-[18px] w-[18px]" />
          {/* Hidden from the reader: the aria-label above already says the
              number, and announcing it twice is how a badge becomes noise. */}
          {unread > 0 && (
            <span
              className="absolute right-0.5 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground"
              aria-hidden
            >
              {unread > BADGE_MAX ? `${BADGE_MAX}+` : unread}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>

      {/* Downwards now. Out to the side was for a trigger halfway down the
          rail, where a panel opening below it ran off the bottom of a short
          window; from the top row the whole window is underneath. The rail is
          16rem and the panel is 24rem, so it covers the page either way —
          `collisionPadding` is what keeps it on screen on a narrow one. Radix
          portals this to the body, so the rail's own overflow scrolling never
          clips it. */}
      <DropdownMenuContent
        side="bottom"
        align="start"
        sideOffset={8}
        collisionPadding={16}
        className="w-[min(24rem,calc(100vw-2rem))] p-0"
      >
        <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-2.5">
          <span className="text-base font-semibold">Notifications</span>
          {/* Disabled rather than hidden when there is nothing unread. A control
              that vanishes teaches nobody it exists; one that is greyed out
              says both what it does and that there is nothing to do. */}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            disabled={unread === 0 || markingAll}
            onClick={() => void markAllRead()}
          >
            <CheckCheck className="h-3.5 w-3.5" /> Mark all as read
          </Button>
        </div>

        {/* Two buttons rather than a tablist: this panel is inside a menu, and
            nesting tab semantics in one is a promise to the screen reader that
            the keyboard behaviour cannot keep. */}
        <div className="flex gap-4 border-b border-border px-3">
          <FilterTab
            label="Inbox"
            active={filter === "inbox"}
            onSelect={() => setFilter("inbox")}
          />
          <FilterTab
            label="Unread"
            badge={unread}
            active={filter === "unread"}
            onSelect={() => setFilter("unread")}
          />
        </div>

        <div className="max-h-[26rem] overflow-y-auto">
          {list.isLoading && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">Loading…</p>
          )}

          {!list.isLoading && items.length === 0 && (
            <div className="px-3 py-8 text-center">
              {filter === "unread" ? (
                <>
                  <p className="text-sm font-medium">You&rsquo;re all caught up</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Everything here has been read. Switch to Inbox for the rest.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium">Nothing yet</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Recallix will tell you here when a meeting is ready, when work falls
                    due, and when a link you shared is opened.
                  </p>
                </>
              )}
            </div>
          )}

          {groups.map((group) => (
            <div key={group.key}>
              <h3 className="sticky top-0 z-10 bg-popover px-3 py-1.5 text-xs font-semibold text-muted-foreground">
                {group.label}
              </h3>
              <ul>
                {group.items.map((n) => (
                  <NotificationRow
                    key={n.id}
                    notification={n}
                    onOpen={() => {
                      if (!n.read) void markRead({ id: n.id, read: true });
                      setOpen(false);
                      // The rail is a slide-over on a narrow window, and the
                      // panel opens on top of it. Following a link without
                      // this leaves both covering the page that was just
                      // navigated to.
                      onNavigate?.();
                    }}
                    onToggleRead={() => void markRead({ id: n.id, read: !n.read })}
                    onDismiss={() => void remove(n.id)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>

        {items.length > 0 && (
          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
            {/* What the end of the list means. Recallix keeps notifications
                until they are cleared, so this says how much is shown rather
                than inventing a retention window it does not have. */}
            <span className="text-xs text-muted-foreground">
              {total > items.length
                ? `Showing the ${items.length} most recent of ${total}.`
                : filter === "unread"
                  ? "That's everything unread."
                  : "That's all your notifications."}
            </span>
            {filter === "inbox" && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground"
                disabled={clearing}
                onClick={() => void clearAll()}
              >
                <Trash2 className="h-3.5 w-3.5" /> Clear
              </Button>
            )}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Inbox / Unread.
 *
 * `aria-pressed` rather than `aria-selected`, for the reason in the panel: these
 * live inside a menu, where a tablist would be a lie about the arrow keys.
 */
function FilterTab({
  label,
  badge,
  active,
  onSelect,
}: {
  label: string;
  badge?: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={cn(
        "-mb-px flex items-center gap-1.5 border-b-2 px-1 py-2 text-sm font-medium transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {badge != null && badge > 0 && (
        <span className="rounded-full bg-primary/10 px-1.5 text-[10px] font-bold tabular-nums text-primary">
          {badge > BADGE_MAX ? `${BADGE_MAX}+` : badge}
        </span>
      )}
    </button>
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
