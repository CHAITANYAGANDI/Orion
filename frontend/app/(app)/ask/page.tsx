"use client";

/**
 * Workspace-wide "ask everything" chat.
 *
 * Unlike the per-meeting chat on the meeting detail page, retrieval here spans
 * every meeting the user owns, so citations carry the meeting they came from and
 * deep-link to that moment (`/meetings/{id}?t=seconds`).
 *
 * The panel itself is shared with the project chat — see `ScopedChat`. What
 * stays here is the wiring: which hooks, which scope, and the state that has to
 * survive a thread being deleted underneath it.
 */

import * as React from "react";
import { toast } from "sonner";
import { Sparkles, Trash2 } from "lucide-react";
import {
  useGetWorkspaceChatQuery,
  useGetWorkspaceSuggestionsQuery,
  useAskWorkspaceChatMutation,
  useClearWorkspaceChatMutation,
  useGetWorkspaceConversationsQuery,
  useCreateWorkspaceConversationMutation,
  useRenameConversationMutation,
  useDeleteConversationMutation,
  useDeleteChatExchangeMutation,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ScopedChat } from "@/components/scoped-chat";
import { WORKSPACE_PROMPTS, toPrompts } from "@/lib/chat-prompts";

export default function AskPage() {
  /**
   * Which thread is on screen. Null means "whatever I was last saying", which
   * is what the server returns for an unspecified conversation — so a first
   * visit needs no conversation to exist.
   */
  const [conversationId, setConversationId] = React.useState<string | null>(null);

  const {
    data: messages,
    isLoading,
    isError: chatError,
  } = useGetWorkspaceChatQuery(conversationId ? { conversationId } : undefined);
  const { data: conversations } = useGetWorkspaceConversationsQuery();
  // Generated from the user's recent meetings and cached server-side, so this
  // is a cheap read. Failure is silent by design: the chips fall back to the
  // static set rather than the page reporting that a convenience is missing.
  const { data: suggestions } = useGetWorkspaceSuggestionsQuery();
  const [ask, { isLoading: asking }] = useAskWorkspaceChatMutation();
  const [clear, { isLoading: clearing }] = useClearWorkspaceChatMutation();
  const [newConversation, { isLoading: starting }] = useCreateWorkspaceConversationMutation();
  const [rename] = useRenameConversationMutation();
  const [removeConversation] = useDeleteConversationMutation();
  const [deleteExchange, { isLoading: deleting }] = useDeleteChatExchangeMutation();

  /**
   * Follow the thread the server actually filed the turn under.
   *
   * Asking without naming one continues the most recent thread or starts a new
   * one, and only the response knows which. Without this the picker would keep
   * saying "Previous chat history" while a named thread sat underneath it.
   */
  React.useEffect(() => {
    if (!conversationId && messages && messages.length > 0) {
      setConversationId(messages[0].conversationId);
    }
  }, [messages, conversationId]);

  /**
   * Recover from a conversation that is no longer there.
   *
   * The explicit resets below cover the cases this page causes itself. This
   * covers the rest — another tab, a stale id, a thread emptied elsewhere —
   * because the alternative is a chat stuck on 404 with no way out but a
   * reload. Dropping the id re-reads the most recent thread, or an empty chat.
   */
  React.useEffect(() => {
    if (chatError && conversationId) setConversationId(null);
  }, [chatError, conversationId]);

  async function send(question: string) {
    try {
      const answer = await ask({
        question,
        conversationId: conversationId ?? undefined,
      }).unwrap();
      setConversationId(answer.conversationId);
    } catch {
      toast.error("Couldn't get an answer.");
    }
  }

  async function onClear() {
    if (!window.confirm("Delete every conversation in this chat? This cannot be undone.")) {
      return;
    }
    try {
      await clear().unwrap();
      setConversationId(null);
      toast.success("Chat history cleared.");
    } catch {
      toast.error("Couldn't clear the conversation.");
    }
  }

  async function onNew() {
    try {
      const created = await newConversation().unwrap();
      setConversationId(created.id);
    } catch {
      toast.error("Couldn't start a new chat.");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Sparkles className="h-6 w-6 text-primary" /> Ask Recallix
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Grounded in every meeting you own — answers cite the exact moment
            they came from.
          </p>
        </div>
        {(conversations?.length ?? 0) > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={onClear}
            disabled={clearing}
            className="gap-2 shrink-0"
          >
            <Trash2 className="h-4 w-4" /> Clear all
          </Button>
        )}
      </div>

      <ScopedChat
        messages={messages}
        conversations={conversations ?? []}
        conversationId={conversationId}
        onSelectConversation={setConversationId}
        loading={isLoading}
        asking={asking}
        deleting={deleting}
        starting={starting}
        prompts={toPrompts(suggestions?.suggestions, WORKSPACE_PROMPTS)}
        emptyLine="Ask a question that spans your meetings."
        thinkingLine="Searching across your meetings…"
        placeholder="Ask anything about your meetings…"
        onSend={send}
        onNewConversation={onNew}
        onRename={async (id, title) => {
          await rename({ conversationId: id, title, scope: "ME" }).unwrap();
        }}
        onDeleteConversation={async (id) => {
          await removeConversation({ conversationId: id, scope: "ME" }).unwrap();
          // The open thread just went; fall back to the most recent one.
          if (id === conversationId) setConversationId(null);
        }}
        onDeleteExchange={async (messageId) => {
          const result = await deleteExchange({ messageId, scope: "ME" }).unwrap();
          // That was the thread's only exchange, so the thread went with it.
          // Holding its id would 404 every read from here.
          if (result.conversationDeleted) setConversationId(null);
        }}
      />
    </div>
  );
}
