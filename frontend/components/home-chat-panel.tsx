"use client";

/**
 * Workspace chat, in the rail beside the conversation list.
 *
 * The same thread as the AI Chat page — see `useWorkspaceChat` — because asking
 * something here and then opening the page to keep going should continue the
 * conversation rather than start a second one that looks identical.
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
 * What it still drops relative to the full page: renaming from the header,
 * deleting an exchange. A four-hundred-pixel column is for asking and reading,
 * and every control that is not those two competes with them for width. The
 * maximise icon is what covers the rest.
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
import { Skeleton } from "@/components/ui/skeleton";

export function HomeChatPanel() {
  const chat = useWorkspaceChat();
  // Only for the maximise control's own state. The pane itself is the shell's.
  const pane = useSidePane();
  // Follows the newest turn, and stops following if the reader scrolls up.
  const threadRef = useThreadScroll([chat.messages, chat.pending]);

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
            <ChatMessageBubble key={msg.id} message={msg}>
              <SourceList citations={msg.citations} />
            </ChatMessageBubble>
          ))
        )}
        {chat.pending && <PendingTurn turn={chat.pending} onRetry={chat.retry} />}
      </>
    </ChatRail>
  );
}
