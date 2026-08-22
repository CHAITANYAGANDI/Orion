"use client";

/**
 * AI Chat, full width.
 *
 * The same archive as the panel on Home — see `useWorkspaceChat` — with the
 * room to do the things a four-hundred-pixel rail cannot: pick a past thread,
 * rename it, delete an exchange.
 *
 * Its own open thread, though. Arriving here does not resume what was being
 * asked in the rail, and asking here does not appear there; both conversations
 * are in this picker if you want them.
 *
 * Laid out as a document rather than as a chat client. There is no avatar, no
 * bubble tail and no left-and-right alternation, because a grounded answer is
 * something you read and quote from, and the two-column messaging metaphor
 * halves the width available to do that in. The question sits above its answer
 * in a lighter weight, which is all the distinction the eye needs.
 */

import * as React from "react";
import { useWorkspaceChat } from "@/lib/use-workspace-chat";
import { ChatComposer } from "@/components/chat-composer";
import { ChatMessageBubble } from "@/components/chat-message";
import { PendingTurn } from "@/components/chat/pending-turn";
import { useThreadScroll } from "@/lib/use-thread-scroll";
import { SourceList } from "@/components/scoped-chat";
import { ChatHistory } from "@/components/chat-history";
import { ChatDock } from "@/components/chat/chat-shell";
import { WORKSPACE_PROMPTS, toPrompts } from "@/lib/chat-prompts";
import { useRotatingPrompts } from "@/lib/use-rotating-prompts";
import { Skeleton } from "@/components/ui/skeleton";

export default function AskPage() {
  const chat = useWorkspaceChat("ask");
  // The thread, not the document — and only while the reader is at the bottom
  // of it. See lib/use-thread-scroll.
  const threadRef = useThreadScroll([chat.messages, chat.pending]);
  const prompts = useRotatingPrompts(
    "ask",
    toPrompts(chat.suggestions, WORKSPACE_PROMPTS),
    chat.conversationId,
  );

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      {/* The same three regions as the rails — header, thread, dock. The
          thread and the dock are held to a readable column: a grounded answer
          is something you quote from, and a line that runs the length of a
          monitor is one the eye loses its place in.

          The header is not. Its two jobs are "which conversation am I in" and
          "start another", and those belong in the corners the eye already goes
          to rather than boxed into the column with the prose. Nor is it ruled
          off, above or below — the regions are told apart by what is in them,
          and two lines across the window to fence in one row of chrome is
          furniture standing where the conversation should be.

          What used to sit on the right was Clear all: one click, from the
          header people use to switch threads, to deleting every conversation
          in the archive — including the ones started in the Home rail, which
          this page never showed. Threads and exchanges are still deletable one
          at a time, from the picker and from the messages, which is where a
          deletion you can check what you are losing belongs. */}
      <header className="shrink-0 px-4 py-2.5 lg:px-6">
        <ChatHistory
          conversations={chat.conversations}
          activeId={chat.conversationId}
          atNewChat={chat.isNew}
          busy={chat.starting}
          // Drawn, and refused. This page is already the full chat, so there
          // is nothing to maximise — but the same header sits on three
          // surfaces, and a maximise button simply missing from one of them
          // reads as a panel that has lost something rather than one that is
          // already at its largest.
          expandDisabled
          spread
          onSelect={chat.setConversationId}
          onNew={() => void chat.startNew()}
          onRename={chat.rename}
          onDelete={chat.remove}
        />
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

      <div className="shrink-0 pt-3 lg:px-2">
        <div className="mx-auto max-w-3xl">
          <ChatDock
            prompts={prompts}
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
