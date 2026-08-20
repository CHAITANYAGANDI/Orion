"use client";

/**
 * The chat, in the rail beside the conversation list.
 *
 * The same thread as the AI Chat page — see `useWorkspaceChat` — because asking
 * something here and then opening the page to keep going should continue the
 * conversation rather than start a second one that looks identical.
 *
 * What it drops relative to the page: the thread picker, renaming, deleting an
 * exchange. A four-hundred-pixel column is for asking and reading, and every
 * control that is not those two is a control competing with them for width. The
 * "open it properly" link is what covers the rest.
 */

import * as React from "react";
import Link from "next/link";
import { Loader2, Maximize2, Plus, ShieldCheck } from "lucide-react";
import { useWorkspaceChat } from "@/lib/use-workspace-chat";
import { ChatComposer } from "@/components/chat-composer";
import { ChatMessageBubble } from "@/components/chat-message";
import { SourceList } from "@/components/scoped-chat";
import { ChatSuggestions } from "@/components/chat-suggestions";
import { WORKSPACE_PROMPTS, toPrompts } from "@/lib/chat-prompts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function HomeChatPanel() {
  const chat = useWorkspaceChat();
  const endRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.messages, chat.asking]);

  const empty = !chat.isLoading && (!chat.messages || chat.messages.length === 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="truncate text-sm font-medium">
          {chat.conversations.find((c) => c.id === chat.conversationId)?.title ?? "New chat"}
        </span>
        <div className="flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => void chat.startNew()}
            // Nothing to start when the thread is already blank. Left live it
            // is a button that appears to do nothing, and each press files
            // another empty conversation into the history list.
            disabled={chat.starting || chat.isNew}
            title={chat.isNew ? "You're already on a new chat" : undefined}
            aria-label="New chat"
          >
            <Plus className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
            <Link href="/ask" aria-label="Open the full chat">
              <Maximize2 className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {chat.isLoading ? (
          <>
            <Skeleton className="h-14 w-3/4" />
            <Skeleton className="h-14 w-2/3" />
          </>
        ) : empty ? (
          <div className="pt-6">
            <p className="mb-3 text-center text-sm text-muted-foreground">
              Ask anything about your conversations.
            </p>
            <ChatSuggestions
              prompts={toPrompts(chat.suggestions, WORKSPACE_PROMPTS)}
              disabled={chat.asking}
              onSend={(q) => void chat.send(q)}
              onCompose={() => undefined}
            />
          </div>
        ) : (
          chat.messages!.map((msg) => (
            <ChatMessageBubble key={msg.id} message={msg}>
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

      {/* Not a reassurance for its own sake: the chat reads every transcript in
          the workspace, and saying where the answer came from is the only way a
          reader knows nothing left it. */}
      <p className="flex items-center gap-1.5 border-t px-3 py-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="h-3 w-3" />
        Answers come from your own meetings, and go nowhere else.
      </p>

      <div className="p-3 pt-2">
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
  );
}
