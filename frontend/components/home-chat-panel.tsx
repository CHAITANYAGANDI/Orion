"use client";

/**
 * Workspace chat, in the rail beside the conversation list.
 *
 * Reads every meeting you own, exactly as the AI Chat page does, and keeps its
 * own open thread. It used to share one with that page, from when the expand
 * button navigated there; expanding widens this rail in place now, so all that
 * remained was two screens showing each other's questions. The conversations
 * are still one archive — anything asked here is in /ask's history picker, and
 * the other way round. See `useWorkspaceChat`.
 *
 * ## What this used to be
 *
 * A heading centred in the middle of an empty panel, the starter prompts under
 * it, and the composer below both. Which meant the panel opened with a wall of
 * chips exactly where the first answer was about to appear, and pushed it down
 * the screen the moment one arrived. The layout now comes from
 * `components/chat/chat-shell` and is the same three regions the meeting rail
 * and the full page use: a header that does not scroll, a thread that does, and
 * a dock that stays put.
 *
 * What it still drops relative to the full page: renaming from the header. A
 * four-hundred-pixel column is for asking and reading, and every control that
 * is not those two competes with them for width. The maximise icon is what
 * covers the rest.
 *
 * Deleting an exchange was on that list and is not any more. It is a bin under
 * your own question, appearing on hover, costing no width at all — and leaving
 * it out meant a question asked in this rail could only be withdrawn by opening
 * a different screen to do it.
 */

import * as React from "react";
import { useWorkspaceChat } from "@/lib/use-workspace-chat";
import { ChatComposer } from "@/components/chat-composer";
import { ChatMessageBubble } from "@/components/chat-message";
import { PendingTurn } from "@/components/chat/pending-turn";
import { useThreadScroll } from "@/lib/use-thread-scroll";
import { SourceList } from "@/components/scoped-chat";
import { ChatHistory } from "@/components/chat-history";
import { ChatDock, ChatRail } from "@/components/chat/chat-shell";
import { toggleSidePaneExpanded, useSidePane } from "@/components/side-pane";
import { WORKSPACE_PROMPTS, toPrompts } from "@/lib/chat-prompts";
import { useRotatingPrompts } from "@/lib/use-rotating-prompts";
import { Skeleton } from "@/components/ui/skeleton";

export function HomeChatPanel() {
  const chat = useWorkspaceChat("home");
  // The prefill for the composer, which owns what is typed. Two of the starter
  // chips are openings rather than questions — "Find every discussion about "
  // — and are meant to land in the box for the reader to finish. This rail
  // passed a no-op for that, so those two chips did nothing at all when
  // clicked. The nonce is what lets the same chip be pressed twice.
  const [compose, setCompose] =
    React.useState<{ text: string; nonce: number } | null>(null);
  // Only for the maximise control's own state. The pane itself is the shell's.
  const pane = useSidePane();
  // Follows the newest turn, and stops following if the reader scrolls up.
  const threadRef = useThreadScroll([chat.messages, chat.pending]);
  // Three of the pool, and a different three next time. Keyed to this rail
  // so it does not deal the same row the full page just dealt.
  const prompts = useRotatingPrompts(
    "home",
    toPrompts(chat.suggestions, WORKSPACE_PROMPTS),
    chat.conversationId,
  );

  return (
    <ChatRail
      header={
        <ChatHistory
          conversations={chat.conversations}
          activeId={chat.conversationId}
          atNewChat={chat.isNew}
          busy={chat.starting}
          // Over the list, not away from it. This used to open /ask, which is
          // the same conversation at a bigger size and therefore looked right
          // — but expanding a panel is a change to the window, and answering
          // it with a navigation threw away the page underneath and wherever
          // the reader had scrolled to in it. The chat you were mid-sentence
          // in survives either way; the list behind it now does too.
          onExpand={toggleSidePaneExpanded}
          expanded={pane.expanded}
          onSelect={chat.setConversationId}
          onNew={() => void chat.startNew()}
          onRename={chat.rename}
          onDelete={chat.remove}
        />
      }
      dock={
        <ChatDock
          prompts={prompts}
          showPrompts={chat.showPrompts}
          busy={chat.asking}
          onSend={(q) => void chat.send(q)}
          onCompose={(prefix) => setCompose({ text: prefix, nonce: Date.now() })}
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
            compose={compose}
            onSend={chat.send}
          />
        </ChatDock>
      }
      scrollRef={threadRef}
    >
      <>
        {chat.isLoading ? (
          <>
            <Skeleton className="h-14 w-3/4" />
            <Skeleton className="h-14 w-2/3" />
          </>
        ) : (
          chat.messages?.map((msg) => (
            // Deleting an exchange works here too now. It was left off as one
            // of the things a four-hundred-pixel rail drops, on the reasoning
            // that the maximise button covers the rest — but the control is a
            // bin under your own question, costs no width, and its absence
            // meant a question asked here could only be withdrawn by opening
            // another screen.
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
      </>
    </ChatRail>
  );
}
