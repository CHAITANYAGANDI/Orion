"use client";

/**
 * The workspace chat's wiring, in one place.
 *
 * Two surfaces show the same conversation — the panel beside the home list and
 * the full AI Chat page — and they must agree about which thread is open rather
 * than each keeping their own idea of it. Both also need the same recovery when
 * a thread is deleted underneath them.
 *
 * The thread does not survive leaving the page. Opening AI Chat, or coming back
 * to Home from anywhere else, gives a clean sheet; the conversations themselves
 * are still in the history picker. See `resetOnLeave` in lib/active-chat.
 *
 * Hooks cannot be chosen conditionally, so the alternative to this is each
 * surface repeating nine `use…Mutation` calls and two effects, which is nine
 * chances for them to drift.
 */

import * as React from "react";
import { toast } from "sonner";
import { useActiveChat } from "@/lib/active-chat";
import {
  useGetWorkspaceChatQuery,
  useGetWorkspaceSuggestionsQuery,
  useAskWorkspaceChatMutation,
  useGetWorkspaceConversationsQuery,
  useCreateWorkspaceConversationMutation,
  useClearWorkspaceChatMutation,
  useRenameConversationMutation,
  useDeleteConversationMutation,
  useDeleteChatExchangeMutation,
  useGetChatModesQuery,
  useGetMeetingsQuery,
  useGetProjectsQuery,
  useGetProjectMeetingsQuery,
} from "@/lib/api";
import { NO_CONTEXT, type ChatContext } from "@/components/chat-composer";
import { usePendingTurn } from "@/lib/pending-turn";
import type { ChatMode } from "@/lib/types";

const SCOPE = "workspace";

export function useWorkspaceChat() {
  // Shared between the home rail and the full page, empty on load, and empty
  // again after you have been anywhere else — see `lib/active-chat` for both.
  const [conversationId, setConversationId] = useActiveChat(SCOPE, {
    resetOnLeave: true,
  });
  const [context, setContext] = React.useState<ChatContext>(NO_CONTEXT);
  const [mode, setMode] = React.useState<ChatMode>("express");

  const {
    data: messages,
    isLoading,
    isError: chatError,
    // Skipped until a thread is named. Asking the server for history without
    // one returns the most recent conversation, which is how opening AI Chat
    // came to resume something from days ago instead of offering a clean
    // sheet.
  } = useGetWorkspaceChatQuery(conversationId ? { conversationId } : undefined, {
    skip: !conversationId,
  });
  const { data: conversations } = useGetWorkspaceConversationsQuery();
  // Folders are resolved to their meetings when the question is asked rather
  // than when the chip is added, so a folder that gains a meeting tomorrow is
  // still the right answer to "ask about this folder".
  const folderMeetings = useProjectMeetingIds(context.projectIds);
  // One list, memoised, because it is both the suggestion query's cache key and
  // what the question is sent with: rebuilding it per render would refetch the
  // chips on every keystroke in the composer.
  const scopedMeetings = React.useMemo(
    () => Array.from(new Set([...context.meetingIds, ...folderMeetings])),
    [context.meetingIds, folderMeetings],
  );
  // Scoped to whatever the composer has been narrowed to. The chips are an
  // answer to "what can I ask here", and "here" changes the moment somebody
  // uses Add context — leaving workspace-level questions on screen over three
  // meetings they just chose is the picker appearing not to have worked.
  //
  // Below `folderMeetings`, which it needs, so it is declared after it.
  const { data: suggestions } = useGetWorkspaceSuggestionsQuery(scopedMeetings);
  const { data: modes } = useGetChatModesQuery();
  // The context picker's catalogue. A generous page rather than every meeting
  // ever: the picker has a filter box, and somebody with four hundred calls is
  // going to type rather than scroll.
  const { data: meetingPage } = useGetMeetingsQuery({ page: 0, size: 100 });
  const { data: projects } = useGetProjectsQuery();

  const [ask, { isLoading: asking }] = useAskWorkspaceChatMutation();
  // The question, on screen from the click rather than from the refetch. See
  // lib/pending-turn for why this is not an optimistic cache patch.
  const pending = usePendingTurn(messages);
  const [newConversation, { isLoading: starting }] = useCreateWorkspaceConversationMutation();
  const [clear, { isLoading: clearing }] = useClearWorkspaceChatMutation();
  const [rename] = useRenameConversationMutation();
  const [removeConversation] = useDeleteConversationMutation();
  const [deleteExchange, { isLoading: deleting }] = useDeleteChatExchangeMutation();

  /**
   * Recover from a thread that is no longer there — deleted in another tab, or
   * emptied from the other surface. Dropping the id re-reads the most recent
   * thread, which beats a chat stuck on 404 with no way out but a reload.
   */
  React.useEffect(() => {
    if (chatError && conversationId) setConversationId(null);
  }, [chatError, conversationId]);

  async function send(question: string) {
    const meetingIds = scopedMeetings;
    // Before the first await, so the question is rendered in the same commit as
    // the composer clearing rather than a network round trip later.
    pending.begin(question);
    try {
      // A question with no thread named gets one of its own, rather than being
      // filed into whatever was last discussed. The server's rule for an
      // unnamed ask is "continue the most recent, or start one", so without
      // this the clean sheet on screen would quietly append to an old
      // conversation — the worst of both, since it would not even look like
      // the thread it was joining.
      const target = conversationId ?? (await newConversation().unwrap()).id;
      const answer = await ask({
        question,
        conversationId: target,
        meetingIds: meetingIds.length > 0 ? meetingIds : undefined,
        mode,
      }).unwrap();
      setConversationId(answer.conversationId);
    } catch {
      // Kept on screen with the failure under it, rather than dropped with a
      // toast that leaves nothing to retry — the composer was cleared on send,
      // so discarding it here means retyping the question.
      pending.fail();
    }
  }

  async function startNew() {
    try {
      const created = await newConversation().unwrap();
      setConversationId(created.id);
      pending.clear();
      // A new thread starts with no narrowing. Carrying the last one's context
      // across is how somebody asks a fresh question and silently gets an answer
      // about three meetings they picked twenty minutes ago.
      setContext(NO_CONTEXT);
    } catch {
      toast.error("Couldn't start a new chat.");
    }
  }

  async function clearAll() {
    try {
      await clear().unwrap();
      setConversationId(null);
      setContext(NO_CONTEXT);
      pending.clear();
      toast.success("Chat history cleared.");
    } catch {
      toast.error("Couldn't clear the conversation.");
    }
  }

  return {
    messages,
    conversations: conversations ?? [],
    conversationId,
    /**
     * Nothing has been said here yet, so "New chat" has nothing to do.
     *
     * Covers both ways of arriving at a blank thread — opening the chat, which
     * now starts fresh, and pressing New on one you had already emptied. Keyed
     * on the messages rather than on the id because the two differ: New
     * creates a real conversation up front, so it has an id and no messages.
     */
    isNew: !isLoading && (messages?.length ?? 0) === 0,
    /**
     * The turn being asked right now, or null.
     *
     * Rendered under the thread by every surface. Null again the moment the
     * persisted copy arrives, in the same render, so the question never appears
     * twice.
     */
    pending: pending.turn,
    /**
     * Starter chips are for an empty thread, and a thread with a question in
     * flight is not one. Leaving three disabled pills across half a
     * four-hundred-pixel rail while the answer is being written puts the chrome
     * where the answer is about to be.
     */
    showPrompts: !isLoading && (messages?.length ?? 0) === 0 && pending.turn === null,
    setConversationId,
    suggestions: suggestions?.suggestions,
    modes: modes ?? [],
    mode,
    setMode,
    context,
    setContext,
    meetings: meetingPage?.content ?? [],
    projects: projects ?? [],

    isLoading,
    asking,
    starting,
    clearing,
    deleting,

    send,
    /** Ask the failed question again. Same path as any other send. */
    retry: () => {
      if (pending.turn) void send(pending.turn.question);
    },
    startNew,
    clearAll,
    rename: async (id: string, title: string) => {
      await rename({ conversationId: id, title, scope: "ME" }).unwrap();
    },
    remove: async (id: string) => {
      await removeConversation({ conversationId: id, scope: "ME" }).unwrap();
      if (id === conversationId) setConversationId(null);
    },
    removeExchange: async (messageId: string) => {
      const result = await deleteExchange({ messageId, scope: "ME" }).unwrap();
      // That was the thread's only exchange, so the thread went with it.
      // Holding its id would 404 every read from here.
      if (result.conversationDeleted) setConversationId(null);
    },
  };
}

/**
 * Every meeting inside the chosen folder.
 *
 * One folder, which is why the picker enforces one: React forbids calling a
 * hook in a loop, so several would mean a fixed number of query slots and a
 * quiet cap somebody discovers by picking one folder too many. Restricting it in
 * the control is the same limit stated honestly, and the case it rules out —
 * "ask across these two folders but not the rest" — is answered by picking the
 * meetings.
 */
function useProjectMeetingIds(projectIds: string[]): string[] {
  const only = projectIds[0];
  const { data } = useGetProjectMeetingsQuery(only ?? "", { skip: !only });
  return React.useMemo(() => (data ?? []).map((m) => m.id), [data]);
}
