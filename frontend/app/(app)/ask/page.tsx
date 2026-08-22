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
import { Trash2 } from "lucide-react";
import { useWorkspaceChat } from "@/lib/use-workspace-chat";
import { ChatComposer } from "@/components/chat-composer";
import { ChatMessageBubble } from "@/components/chat-message";
import { PendingTurn } from "@/components/chat/pending-turn";
import { useThreadScroll } from "@/lib/use-thread-scroll";
import { SourceList } from "@/components/scoped-chat";
import { ChatHistory } from "@/components/chat-history";
import { ChatDock } from "@/components/chat/chat-shell";
import { WORKSPACE_PROMPTS, toPrompts } from "@/lib/chat-prompts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export default function AskPage() {
  const chat = useWorkspaceChat();
  // The thread, not the document — and only while the reader is at the bottom
  // of it. See lib/use-thread-scroll.
  const threadRef = useThreadScroll([chat.messages, chat.pending]);

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      {/* The same three regions as the rails — header, thread, dock — at a
          width you can read a cited answer in. Wider is not better here: a
          grounded answer is something you quote from, and a line that runs the
          length of a monitor is one the eye loses its place in. */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2.5 lg:px-6">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <ChatHistory
              conversations={chat.conversations}
              activeId={chat.conversationId}
              atNewChat={chat.isNew}
              busy={chat.starting}
              // Drawn, and refused. This page is already the full chat, so
              // there is nothing to maximise — but the same header sits on
              // three surfaces, and a maximise button simply missing from one
              // of them reads as a panel that has lost something rather than
              // one that is already at its largest.
              expandDisabled
              onSelect={chat.setConversationId}
              onNew={() => void chat.startNew()}
              onRename={chat.rename}
              onDelete={chat.remove}
            />
          </div>
          {chat.conversations.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 gap-1.5 text-muted-foreground"
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
        </div>
      </header>

      <div ref={threadRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6 lg:px-6">
        <div className="mx-auto max-w-3xl space-y-5">
          {chat.isLoading ? (
            <>
              <Skeleton className="h-20 w-3/4" />
              <Skeleton className="h-20 w-2/3" />
            </>
          ) : (
            chat.messages?.map((msg) => (
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
          {chat.pending && <PendingTurn turn={chat.pending} onRetry={chat.retry} />}
        </div>
      </div>

      <div className="shrink-0 border-t pt-3 lg:px-2">
        <div className="mx-auto max-w-3xl">
          <ChatDock
            prompts={toPrompts(chat.suggestions, WORKSPACE_PROMPTS)}
            showPrompts={chat.showPrompts}
            busy={chat.asking}
            onSend={(q) => void chat.send(q)}
            onCompose={() => undefined}
          >
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
          </ChatDock>
        </div>
      </div>
    </div>
  );
}
