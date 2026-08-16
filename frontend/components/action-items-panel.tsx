"use client";

/**
 * Everything you owe, in the panel beside the chat.
 *
 * Workspace-wide, not per meeting. The list on a meeting page answers "what did
 * this call commit us to"; this one answers "what have I got to do", which is
 * the question somebody actually opens the app with — and the two are only the
 * same when you have had exactly one meeting.
 *
 * **Adding one here creates a task with no meeting.** "Write the migration" is
 * not something anybody said in a call, and attaching it to the most recent one
 * would file it in a conversation it was never mentioned in and delete it the
 * day that conversation is deleted. See V36 for why the row learned to own
 * itself instead.
 *
 * **Finished work is folded away rather than hidden.** A tracker that forgets
 * what you ticked cannot answer "did I do that", which is the second question
 * anybody asks it. Collapsed, with a count, so it costs a click and no screen.
 */

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Plus, ChevronDown, ChevronRight, ListChecks, Loader2 } from "lucide-react";
import {
  useGetActionItemsQuery,
  usePatchActionItemMutation,
  useCreateStandaloneActionItemMutation,
} from "@/lib/api";
import type { ActionItemResponse } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";
import { dueLabel, dueTone } from "@/lib/due";
import { cn } from "@/lib/utils";

export function ActionItemsPanel() {
  // Everything, finished included, because the completed section is part of the
  // answer. One request rather than two: the split is a property of the rows.
  const { data, isLoading } = useGetActionItemsQuery({ status: undefined, size: 100 });
  const [patch] = usePatchActionItemMutation();
  const [create, { isLoading: creating }] = useCreateStandaloneActionItemMutation();

  const [draft, setDraft] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [showDone, setShowDone] = React.useState(false);

  const items = data?.content ?? [];
  const open = items.filter((i) => i.status !== "DONE");
  const done = items.filter((i) => i.status === "DONE");

  async function add() {
    const title = draft.trim();
    if (!title) {
      setAdding(false);
      return;
    }
    try {
      await create({ title }).unwrap();
      setDraft("");
      // Stays open: adding one thing you remembered usually means adding two.
    } catch {
      toast.error("Couldn't add that.");
    }
  }

  async function toggle(item: ActionItemResponse) {
    try {
      await patch({
        id: item.id,
        body: { status: item.status === "DONE" ? "OPEN" : "DONE" },
      }).unwrap();
    } catch {
      toast.error("Couldn't update that.");
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-3">
        {adding ? (
          <div className="flex items-center gap-2">
            <span className="h-4 w-4 shrink-0 rounded border" aria-hidden />
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void add();
                } else if (e.key === "Escape") {
                  setDraft("");
                  setAdding(false);
                }
              }}
              onBlur={() => void add()}
              placeholder="What needs doing?"
              aria-label="New action item"
              className="h-9 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus:border-primary"
            />
            {creating && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <Plus className="h-4 w-4" /> Add action item
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">

        {isLoading ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-3/4" />
          </div>
        ) : open.length === 0 ? (
          <Empty />
        ) : (
          <ul className="p-2">
            {open.map((item) => (
              <Row key={item.id} item={item} onToggle={() => void toggle(item)} />
            ))}
          </ul>
        )}
      </div>

      <div className="border-t px-3 py-2">
        {/* The panel is a list; the page behind this link is the tracker, with
            the filters, the bulk actions and the owner breakdown. It is also
            where the deadline notifications point. */}
        <Link
          href="/action-items"
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Open the full tracker
        </Link>
      </div>

      {done.length > 0 && (
        <div className="border-t">
          <button
            type="button"
            onClick={() => setShowDone((v) => !v)}
            aria-expanded={showDone}
            className="flex w-full items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors hover:bg-accent"
          >
            {showDone ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            Completed ({done.length})
          </button>
          {showDone && (
            <ul className="max-h-56 overflow-y-auto p-2 pt-0">
              {done.map((item) => (
                <Row key={item.id} item={item} onToggle={() => void toggle(item)} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  item,
  onToggle,
}: {
  item: ActionItemResponse;
  onToggle: () => void;
}) {
  const done = item.status === "DONE";
  const due = dueLabel(item);

  return (
    <li className="group flex items-start gap-2 rounded-md px-1 py-1.5 transition-colors hover:bg-accent/50">
      <input
        type="checkbox"
        checked={done}
        onChange={onToggle}
        aria-label={done ? `Reopen ${item.title}` : `Complete ${item.title}`}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
      />
      <span className="min-w-0 flex-1">
        <span className={cn("block text-sm", done && "text-muted-foreground line-through")}>
          {item.title}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {due && <span className={dueTone(item.dueStatus)}>{due}</span>}
          {item.ownerName && <span>{item.ownerName}</span>}
          {/* A task typed here has no meeting, and says so by having no link
              rather than by claiming one it does not have. */}
          {item.meetingId && item.meetingTitle && (
            <Link
              href={`/meetings/${item.meetingId}?tab=actions`}
              className="max-w-[140px] truncate underline-offset-2 hover:underline"
            >
              {item.meetingTitle}
            </Link>
          )}
        </span>
      </span>
    </li>
  );
}

function Empty() {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <ListChecks className="h-6 w-6 text-muted-foreground" />
      <p className="mt-3 font-medium">No current action items</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Your action items will appear here when assigned
      </p>
    </div>
  );
}
