"use client";

/**
 * The chat-history picker: past conversations, grouped by when they were last
 * spoken to.
 *
 * One component serves both chats. They differ only in which scope they list,
 * and a picker that knew the difference would be two pickers.
 *
 * The grouping is the feature — see `lib/conversations.ts`. A flat list sorted
 * by date is a log; "Today / Yesterday / Past week" is what lets somebody find
 * the thread they had this morning without reading timestamps.
 */

import * as React from "react";
import { toast } from "sonner";
import { ChevronDown, History, Pencil, Plus, Trash2, Check, X } from "lucide-react";
import type { ChatConversation } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { groupConversations, relativeTime } from "@/lib/conversations";
import { cn } from "@/lib/utils";

export interface ChatHistoryProps {
  conversations: ChatConversation[];
  /** The thread on screen. Null while the most recent one is being shown. */
  activeId: string | null;
  onSelect: (conversationId: string) => void;
  onNew: () => void;
  onRename: (conversationId: string, title: string) => Promise<void>;
  onDelete: (conversationId: string) => Promise<void>;
  busy?: boolean;
  /**
   * The thread on screen is already an empty one, so New has nothing to do.
   *
   * Separate from `busy`, which means "a request is in flight". They both
   * disable the button and they are not the same thing — one is temporary and
   * the other is a statement about where you are.
   */
  atNewChat?: boolean;
}

export function ChatHistory({
  conversations,
  activeId,
  onSelect,
  onNew,
  onRename,
  onDelete,
  busy,
  atNewChat,
}: ChatHistoryProps) {
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  // Close on an outside click or Escape. A menu that traps the page behind it
  // is worse than one extra click to dismiss.
  React.useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setEditing(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setEditing(null);
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Recomputed per open rather than per render: the boundaries are calendar
  // days, so a `new Date()` in the render path would make the groups a moving
  // target across re-renders that have nothing to do with time.
  const groups = React.useMemo(
    () => (open ? groupConversations(conversations) : []),
    [conversations, open],
  );

  const active = conversations.find((c) => c.id === activeId);
  const label = active?.title || "Previous chat history";

  return (
    <div ref={rootRef} className="relative">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
        >
          <History className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="max-w-[220px] truncate">{label}</span>
          <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")} />
        </button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onNew}
          disabled={busy || atNewChat}
          title={atNewChat ? "You're already on a new chat" : undefined}
          className="gap-1.5"
        >
          <Plus className="h-4 w-4" /> New chat
        </Button>
      </div>

      {open && (
        <div
          role="menu"
          aria-label="Previous chat history"
          className="absolute left-0 z-40 mt-2 max-h-[60vh] w-[320px] overflow-y-auto rounded-lg border bg-popover p-2 shadow-lg"
        >
          {conversations.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              No past conversations yet.
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.name} className="mb-1">
                <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                  {group.name}
                </p>
                {group.conversations.map((c) => (
                  <Row
                    key={c.id}
                    conversation={c}
                    active={c.id === activeId}
                    editing={editing === c.id}
                    onEdit={() => setEditing(c.id)}
                    onCancelEdit={() => setEditing(null)}
                    onSelect={() => {
                      onSelect(c.id);
                      setOpen(false);
                    }}
                    onRename={async (title) => {
                      await onRename(c.id, title);
                      setEditing(null);
                    }}
                    onDelete={() => onDelete(c.id)}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  conversation,
  active,
  editing,
  onEdit,
  onCancelEdit,
  onSelect,
  onRename,
  onDelete,
}: {
  conversation: ChatConversation;
  active: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSelect: () => void;
  onRename: (title: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [draft, setDraft] = React.useState(conversation.title);

  React.useEffect(() => {
    setDraft(conversation.title);
  }, [conversation.title, editing]);

  async function save() {
    const title = draft.trim();
    // An empty rename is refused by the server; treating it as a cancel keeps
    // an error toast off the screen for something obviously incomplete.
    if (!title || title === conversation.title) {
      onCancelEdit();
      return;
    }
    try {
      await onRename(title);
    } catch {
      toast.error("Couldn't rename that conversation.");
    }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1 px-2 py-1.5">
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              // Kept away from the menu's own Escape handler: abandoning a
              // rename should leave the row, not close the list and lose the
              // user's place halfway through tidying it.
              e.stopPropagation();
              onCancelEdit();
            }
          }}
          className="h-8"
          aria-label="Conversation name"
        />
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => void save()} aria-label="Save name">
          <Check className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onCancelEdit} aria-label="Cancel rename">
          <X className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-md px-2 py-1.5 transition-colors hover:bg-accent",
        active && "ring-1 ring-inset ring-foreground/25",
      )}
    >
      <button
        type="button"
        role="menuitem"
        onClick={onSelect}
        className="min-w-0 flex-1 text-left"
      >
        <span className="block truncate text-sm font-medium">
          {conversation.title || "Untitled"}
        </span>
        <span className="block text-xs text-muted-foreground">
          {relativeTime(conversation.updatedAt)}
        </span>
      </button>
      <div className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={onEdit}
          aria-label={`Rename ${conversation.title}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          aria-label={`Delete ${conversation.title}`}
          onClick={async () => {
            try {
              await onDelete();
            } catch {
              toast.error("Couldn't delete that conversation.");
            }
          }}
        >
          <Trash2 className="h-3.5 w-3.5 text-destructive" />
        </Button>
      </div>
    </div>
  );
}
