"use client";

/**
 * The workspace chat's wiring, in one place.
 *
 * Two surfaces show the same conversation — the panel beside the home list and
 * the full AI Chat page — and they must be the same conversation, not two that
 * happen to look alike. Asking something in the rail and then opening the page
 * should continue the thread, and both need the same recovery when a thread is
 * deleted underneath them.
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
import type { ChatMode } from "@/lib/types";

const SCOPE = "workspace";

export function useWorkspaceChat() {
  // Shared between the home rail and the full page, and empty on load — see
  // `lib/active-chat` for why this is not component state.
  const [conversationId, setConversationId] = useActiveChat(SCOPE);
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
  const { data: suggestions } = useGetWorkspaceSuggestionsQuery();
  const { data: modes } = useGetChatModesQuery();
  // The context picker's catalogue. A generous page rather than every meeting
  // ever: the picker has a filter box, and somebody with four hundred calls is
  // going to type rather than scroll.
  const { data: meetingPage } = useGetMeetingsQuery({ page: 0, size: 100 });
  const { data: projects } = useGetProjectsQuery();

  const [ask, { isLoading: asking }] = useAskWorkspaceChatMutation();
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

  // Folders are resolved to their meetings when the question is asked rather
  // than when the chip is added, so a folder that gains a meeting tomorrow is
  // still the right answer to "ask about this folder".
  const folderMeetings = useProjectMeetingIds(context.projectIds);

  async function send(question: string) {
    const meetingIds = Array.from(new Set([...context.meetingIds, ...folderMeetings]));
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
      toast.error("Couldn't get an answer.");
    }
  }

  async function startNew() {
    try {
      const created = await newConversation().unwrap();
      setConversationId(created.id);
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
      toast.success("Chat history cleared.");
    } catch {
      toast.error("Couldn't clear the conversation.");
    }
  }

  return {
    messages,
    conversations: conversations ?? [],
    conversationId,
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
