"use client";

/**
 * AI Chat, full width.
 *
 * The same conversation as the panel on Home — see `useWorkspaceChat` — with
 * the room to do the things a four-hundred-pixel rail cannot: pick a past
 * thread, rename it, delete an exchange, clear the lot.
 *
 * Laid out as a document rather than as a chat client. There is no avatar, no
 * bubble tail and no left-and-right alternation, because a grounded answer is
 * something you read and quote from, and the two-column messaging metaphor
 * halves the width available to do that in. The question sits above its answer
 * in a lighter weight, which is all the distinction the eye needs.
 */

import * as React from "react";
import { toast } from "sonner";
import { ChevronDown, History, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useWorkspaceChat } from "@/lib/use-workspace-chat";
import { ChatComposer } from "@/components/chat-composer";
import { ChatMessageBubble } from "@/components/chat-message";
import { SourceList } from "@/components/scoped-chat";
import { ChatSuggestions } from "@/components/chat-suggestions";
import { WORKSPACE_PROMPTS, toPrompts } from "@/lib/chat-prompts";
import { groupConversations, relativeTime } from "@/lib/conversations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { ChatConversation } from "@/lib/types";

export default function AskPage() {
  const chat = useWorkspaceChat();
  const endRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.messages, chat.asking]);

  const empty = !chat.isLoading && (!chat.messages || chat.messages.length === 0);
  const active = chat.conversations.find((c) => c.id === chat.conversationId);

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-2.5 lg:px-6">
        <ThreadPicker
          conversations={chat.conversations}
          activeId={chat.conversationId}
          label={active?.title ?? "New chat"}
          onSelect={chat.setConversationId}
          onRename={chat.rename}
          onDelete={chat.remove}
        />
        <div className="flex shrink-0 items-center gap-2">
          {chat.conversations.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              disabled={chat.clearing}
              onClick={() => {
                if (window.confirm("Delete every conversation in this chat? This cannot be undone.")) {
                  void chat.clearAll();
                }
              }}
            >
              <Trash2 className="h-4 w-4" />
              <span className="hidden sm:inline">Clear all</span>
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => void chat.startNew()}
            disabled={chat.starting || chat.isNew}
            title={chat.isNew ? "You're already on a new chat" : undefined}
          >
            <Plus className="h-4 w-4" /> New
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 lg:px-6">
        <div className="mx-auto max-w-3xl space-y-5">
          {chat.isLoading ? (
            <>
              <Skeleton className="h-20 w-3/4" />
              <Skeleton className="h-20 w-2/3" />
            </>
          ) : empty ? (
            <div className="pt-10 text-center">
              <h1 className="text-2xl font-semibold">Ask anything about your conversations</h1>
              <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
                Grounded in every meeting you own. Answers cite the exact moment
                they came from, so you can check them.
              </p>
              <div className="mx-auto mt-6 max-w-xl">
                <ChatSuggestions
                  prompts={toPrompts(chat.suggestions, WORKSPACE_PROMPTS)}
                  disabled={chat.asking}
                  onSend={(q) => void chat.send(q)}
                  onCompose={() => undefined}
                />
              </div>
            </div>
          ) : (
            chat.messages!.map((msg) => (
              <ChatMessageBubble
                key={msg.id}
                message={msg}
                deleting={chat.deleting}
                onDelete={chat.removeExchange}
              >
                <SourceList citations={msg.citations} />
              </ChatMessageBubble>
            ))
          )}
          {chat.asking && (
            <div className="flex justify-start">
              <div className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />
                Searching across your meetings…
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="border-t px-4 py-3 lg:px-6">
        <div className="mx-auto max-w-3xl">
          <ChatComposer
            busy={chat.asking}
            modes={chat.modes}
            mode={chat.mode}
            onModeChange={chat.setMode}
            context={chat.context}
            onContextChange={chat.setContext}
            meetings={chat.meetings}
            projects={chat.projects}
            onSend={chat.send}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Every past thread, grouped by when it was last spoken to.
 *
 * The grouping is the feature — a flat list sorted by date is a log, and
 * "Today / Yesterday / Past week" is what lets somebody find the conversation
 * they had this morning without reading timestamps.
 */
function ThreadPicker({
  conversations,
  activeId,
  label,
  onSelect,
  onRename,
  onDelete,
}: {
  conversations: ChatConversation[];
  activeId: string | null;
  label: string;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
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

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
      >
        <History className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="max-w-[260px] truncate">{label}</span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Chats"
          className="absolute left-0 z-40 mt-1 max-h-[60vh] w-[320px] overflow-y-auto rounded-lg border bg-popover p-2 shadow-lg"
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
                  <ThreadRow
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

function ThreadRow({
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
    // An empty rename is refused by the server; treating it as a cancel keeps an
    // error toast off the screen for something obviously incomplete.
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
              // rename should leave the row, not close the list.
              e.stopPropagation();
              onCancelEdit();
            }
          }}
          className="h-8"
          aria-label="Conversation name"
        />
        <Button size="sm" variant="ghost" className="h-8" onClick={() => void save()}>
          Save
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
      <button type="button" role="menuitem" onClick={onSelect} className="min-w-0 flex-1 text-left">
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
