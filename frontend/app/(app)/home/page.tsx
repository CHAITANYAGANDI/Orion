"use client";

/**
 * Home.
 *
 * Your conversations on the left, and on the right the two things you do with
 * them: ask a question about them, or look at what they committed you to. That
 * pairing is the whole design — the old dashboard led with usage bars and a plan
 * summary, which is information about the account rather than about the work,
 * and nobody opens a meeting recorder to find out how many minutes they have
 * left.
 *
 * The list is grouped by day and the day is a heading, not a column, because a
 * meeting archive is read as a diary. The scope picker above it answers the one
 * question the list cannot: whether "yours" means the ones you recorded or
 * everything in the workspace.
 */

import * as React from "react";
import Link from "next/link";
import {
  Sparkles,
  ListChecks,
  ChevronDown,
  FileAudio,
  Youtube,
  FileText,
  Upload,
  Mic,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { useGetMeetingsQuery } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/status-badge";
import { ActionItemsPanel } from "@/components/action-items-panel";
import { HomeChatPanel } from "@/components/home-chat-panel";
import { formatDuration } from "@/lib/format";
import { groupByDay } from "@/lib/home";
import type { MeetingResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Whose conversations to list.
 *
 * Otter offers a fourth, "Shared with me", and Recallix cannot: one account per
 * workspace means nobody can share anything *into* it. Offering the row anyway
 * would be a filter that is permanently empty and reads as a fault.
 */
const SCOPES = [
  { value: "for-you", label: "For you", hint: "recent and unread" },
  { value: "mine", label: "My Conversations", hint: "ones you recorded or uploaded" },
  { value: "all", label: "All Conversations", hint: "everything in this workspace" },
] as const;

type Scope = (typeof SCOPES)[number]["value"];

type Panel = "chat" | "actions";

export default function HomePage() {
  const [scope, setScope] = React.useState<Scope>("for-you");
  const [panel, setPanel] = React.useState<Panel>("chat");
  const [panelOpen, setPanelOpen] = React.useState(true);

  const { data, isLoading } = useGetMeetingsQuery({ page: 0, size: 50 });
  // Derived from `data` rather than from a `?? []` above it: the fallback array
  // is a new value on every render, which would make the grouping below rerun
  // — and `new Date()` inside it produce different day boundaries — on renders
  // that have nothing to do with the data changing.
  const shown = React.useMemo(() => scoped(data?.content ?? [], scope), [data, scope]);
  const groups = React.useMemo(() => groupByDay(shown), [shown]);

  return (
    <div className="flex h-[calc(100vh-4rem)]">
      <section className="min-w-0 flex-1 overflow-y-auto px-4 py-4 lg:px-6">
        <div className="mx-auto max-w-3xl">
          <div className="mb-4 flex items-center justify-between gap-3">
            <ScopePicker value={scope} onChange={setScope} />
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setPanelOpen((v) => !v)}
              aria-label={panelOpen ? "Hide the side panel" : "Show the side panel"}
            >
              {panelOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </Button>
          </div>

          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : shown.length === 0 ? (
            <EmptyState scope={scope} />
          ) : (
            groups.map((group) => (
              <div key={group.key} className="mb-6">
                <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                  {group.label}
                </h2>
                <ul className="space-y-2">
                  {group.meetings.map((meeting) => (
                    <ConversationRow key={meeting.id} meeting={meeting} />
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </section>

      <aside
        className={cn(
          "w-full max-w-md shrink-0 border-l bg-card lg:block",
          panelOpen ? "block" : "hidden",
          "fixed inset-y-16 right-0 z-20 lg:static lg:inset-auto lg:z-auto",
        )}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-1 border-b px-2">
            <PanelTab
              icon={<Sparkles className="h-4 w-4" />}
              label="AI Chat"
              active={panel === "chat"}
              onClick={() => setPanel("chat")}
            />
            <PanelTab
              icon={<ListChecks className="h-4 w-4" />}
              label="Action Items"
              active={panel === "actions"}
              onClick={() => setPanel("actions")}
            />
          </div>
          <div className="min-h-0 flex-1">
            {/* Both stay mounted: switching to the tasks and back should not
                throw away a half-typed question or re-run the chat's history
                fetch. Hidden rather than unmounted. */}
            <div className={cn("h-full", panel === "chat" ? "block" : "hidden")}>
              <HomeChatPanel />
            </div>
            <div className={cn("h-full", panel === "actions" ? "block" : "hidden")}>
              <ActionItemsPanel />
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

/* -------------------------------- the list -------------------------------- */

/**
 * Narrow the list to a scope.
 *
 * "For you" is the recent slice rather than a different query: a workspace with
 * one account has no notion of relevance beyond recency, and inventing a ranking
 * would be a claim the data cannot support. "Mine" and "All" are identical today
 * for the same reason, and are kept apart because the distinction becomes real
 * the moment a workspace has two people in it — at which point this is the one
 * place that has to change.
 */
function scoped(meetings: MeetingResponse[], scope: Scope): MeetingResponse[] {
  if (scope === "for-you") {
    return meetings.slice(0, 20);
  }
  return meetings;
}

function ScopePicker({
  value,
  onChange,
}: {
  value: Scope;
  onChange: (scope: Scope) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = SCOPES.find((s) => s.value === value) ?? SCOPES[0];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
      >
        {current.label}
        <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 z-30 mt-1 w-56 overflow-hidden rounded-lg border bg-popover shadow-lg"
        >
          {SCOPES.map((s) => (
            <button
              key={s.value}
              type="button"
              role="menuitemradio"
              aria-checked={s.value === value}
              onClick={() => {
                onChange(s.value);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
                s.value === value && "bg-accent/60",
              )}
            >
              <span>
                <span className="block">{s.label}</span>
                <span className="block text-xs text-muted-foreground">{s.hint}</span>
              </span>
              {s.value === value && <span aria-hidden>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ConversationRow({ meeting }: { meeting: MeetingResponse }) {
  const Icon =
    meeting.sourceType === "YOUTUBE"
      ? Youtube
      : meeting.sourceType === "DOCUMENT"
        ? FileText
        : FileAudio;

  return (
    <li>
      <Link
        href={`/meetings/${meeting.id}`}
        className="flex gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/40"
      >
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{meeting.title}</span>
            {meeting.status !== "READY" && <StatusBadge status={meeting.status} />}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {new Date(meeting.createdAt).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })}
            {meeting.durationSeconds ? ` · ${formatDuration(meeting.durationSeconds)}` : ""}
            {meeting.tags.length > 0 ? ` · ${meeting.tags.slice(0, 3).join(", ")}` : ""}
          </span>
        </span>
      </Link>
    </li>
  );
}

function EmptyState({ scope }: { scope: Scope }) {
  const { userId } = useAuth();
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
      <FileAudio className="h-8 w-8 text-muted-foreground" />
      <p className="mt-3 font-medium">
        {scope === "for-you" ? "Nothing here yet" : "No conversations"}
      </p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Record a meeting from your browser, or bring in a file you already have.
        {userId ? "" : ""}
      </p>
      <div className="mt-4 flex gap-2">
        <Button asChild>
          <Link href="/record">
            <Mic className="mr-2 h-4 w-4" /> Record
          </Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/upload">
            <Upload className="mr-2 h-4 w-4" /> Import
          </Link>
        </Button>
      </div>
    </div>
  );
}

function PanelTab({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 border-b-2 px-3 py-3 text-sm font-medium transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
