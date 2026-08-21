"use client";

/**
 * What you gave yourself to do, in the panel beside the chat.
 *
 * **Only what nobody's transcript produced.** This used to list every action
 * item in the workspace, and a commitment made in a meeting then existed in
 * three places at once — on its meeting, here, and on a tracker page — with
 * nothing to say which of them you were meant to act on, or which one ticking
 * it off in would count. A commitment belongs to the conversation that produced
 * it: it is read on that meeting, beside the sentence it came from, and it is
 * ticked off there. What is left in here is what somebody typed, which belongs
 * to no meeting and has nowhere else to be.
 *
 * The tracker page is gone with it. A third list of the same rows, with filters
 * on it, was the reason the same task could be in three places.
 *
 * **Adding one here creates a task with no meeting.** "Write the migration" is
 * not something anybody said in a call, and attaching it to the most recent one
 * would file it in a conversation it was never mentioned in and delete it the
 * day that conversation is deleted. See V36 for why the row learned to own
 * itself instead. That is now the only kind of row this panel has.
 *
 * **Finished work is folded away rather than hidden.** A tracker that forgets
 * what you ticked cannot answer "did I do that", which is the second question
 * anybody asks it. Collapsed, with a count, so it costs a click and no screen.
 */

import * as React from "react";
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
  /*
   * Your own list, and only your own.
   *
   * `standalone` is the whole point of this panel now. It used to show every
   * action item in the workspace, which meant a commitment somebody made in a
   * meeting appeared in three places — on its meeting, in this panel, and on a
   * tracker page — with no way to tell which one you were meant to act on. What
   * a transcript produced is read on the meeting that produced it, where the
   * sentence behind it is a click away. What is left here is what somebody
   * typed for themselves, which belongs to no meeting and has nowhere else to
   * be.
   *
   * Everything, finished included, because the completed section is part of the
   * answer. One request rather than two: the split is a property of the rows.
   */
  const { data, isLoading } = useGetActionItemsQuery({
    status: undefined,
    standalone: true,
    size: 100,
  });
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
          {/* No meeting link, because nothing in this list has one. The query
              asks for `standalone` items only — see the panel above — so a
              branch for a meeting title here would be a branch that never
              runs, kept alive to describe a state this list cannot be in. */}
        </span>
      </span>
    </li>
  );
}

function Empty() {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <ListChecks className="h-6 w-6 text-muted-foreground" />
      <p className="mt-3 font-medium">Nothing on your list</p>
      {/* Says where the others went. Twenty-one items left this panel when it
          narrowed to what you type yourself, and an empty box with no
          explanation reads as a fault rather than a change. */}
      <p className="mt-1 text-sm text-muted-foreground">
        Add whatever you need to do. What a meeting committed you to stays on
        that meeting.
      </p>
    </div>
  );
}
