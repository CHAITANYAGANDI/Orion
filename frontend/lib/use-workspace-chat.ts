"use client";

/**
 * The workspace chat's wiring, in one place.
 *
 * Two surfaces ask across the whole workspace — the panel beside the home list
 * and the full AI Chat page — and they share everything except which thread
 * each one is currently on. Both also need the same recovery when a thread is
 * deleted underneath them.
 *
 * Hooks cannot be chosen conditionally, so the alternative to this is each
 * surface repeating nine `use…Mutation` calls and two effects, which is nine
 * chances for them to drift.
 *
 * ## Why they no longer share the open thread
 *
 * They did, and it was deliberate: the home rail's expand button used to
 * *navigate* to /ask, so the two had to be one conversation or expanding a
 * panel would have abandoned a half-typed question. Expanding widens the rail
 * in place now — see `onExpand` in components/home-chat-panel — so nothing
 * depends on it any more, and what was left was two screens showing each
 * other's questions for no reason anybody could see.
 *
 * So the thread is keyed per surface. What is still shared is the *archive*:
 * one conversation list, one set of endpoints. A thread started
 * on Home is still in /ask's history picker and can be opened there
 * deliberately — it just is not adopted by accident.
 *
 * ## And why the thread now outlives a navigation
 *
 * `resetOnLeave` was how the sharing was contained: forgetting the thread on
 * unmount meant neither surface could inherit the other's. Keying them apart
 * does that precisely, so the blunt instrument comes out — and Home keeps what
 * you were asking while you go and look at a meeting. Nothing is persisted, so
 * a reload still starts both from a clean sheet.
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
import { usePendingTurn, announceAnswer } from "@/lib/pending-turn";
import type { ChatMode } from "@/lib/types";

/**
 * Which screen is asking.
 *
 * Only ever used to key the open thread. Both surfaces read the same workspace
 * scope on the server, so this must not leak into any request — see the note
 * above.
 */
export type ChatSurface = "home" | "ask";

export function useWorkspaceChat(surface: ChatSurface) {
  // One per surface. Empty on load, and held for as long as this tab lives —
  // see `lib/active-chat` for both.
  const [conversationId, setConversationId] = useActiveChat(`workspace:${surface}`);
  const [context, setContext] = React.useState<ChatContext>(NO_CONTEXT);
  const [mode, setMode] = React.useState<ChatMode>("express");

  const {
    currentData: messages,
    isFetching,
    isError: chatError,
    // Skipped until a thread is named. Asking the server for history without
    // one returns the most recent conversation, which is how opening AI Chat
    // came to resume something from days ago instead of offering a clean
    // sheet.
    //
    // **`currentData`, not `data`, and the difference was a bug.** RTK Query
    // deliberately keeps the last successful result in `data` when a query
    // becomes skipped, so that a query which skips and un-skips does not flash
    // empty. Here skipping *is* the statement that no thread is open — it is
    // what `remove` and the 404 guard below do by setting the id to null — so
    // `data` went on serving the messages of a conversation that had just been
    // deleted. Deleting the thread you were reading left it on screen, with
    // "New chat" still offered as though you were somewhere else.
    // `currentData` is the current cache entry's own data, and a skipped query
    // has no current entry.
  } = useGetWorkspaceChatQuery(conversationId ? { conversationId } : undefined, {
    skip: !conversationId,
  });

  // The skeleton is for "there is nothing to show and something is coming",
  // which is not the same as `isFetching`. A skipped query is not fetching at
  // all, and a refetch of a thread already on screen — which is what follows
  // every answer — must not replace it with two grey bars.
  const isLoading = isFetching && !messages;
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
  // Scoped, so a question still being answered survives going to look at a
  // meeting and coming back. Same key as the thread itself, for the same
  // reason: Home and /ask are two screens, and one's question has no business
  // appearing on the other.
  const pending = usePendingTurn(messages, `workspace:${surface}`);
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
      // Adopted *before* the answer is waited for, not after.
      //
      // It used to be set from the response, which meant a first question on a
      // new thread had nowhere to belong for as long as the answer took. Leave
      // during that window and the surface came back to a clean sheet: the
      // question had been asked, the answer was written, and the only way to
      // find either was the conversation picker. The thread exists from the
      // line above, so this is simply when it becomes true.
      setConversationId(target);
      // Where the question was asked from, so the answer can say where to go
      // back to if it lands while the user is somewhere else.
      const askedOn = typeof window === "undefined" ? "" : window.location.pathname;
      const answer = await ask({
        question,
        conversationId: target,
        meetingIds: meetingIds.length > 0 ? meetingIds : undefined,
        mode,
      }).unwrap();
      setConversationId(answer.conversationId);
      announceAnswer(askedOn);
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

  /**
   * Delete every conversation in the workspace archive.
   *
   * Nothing offers this at the moment: the control was in /ask's header, one
   * click away from a picker people use to switch threads, and it took the
   * Home rail's conversations with it. Kept because the endpoint is real and
   * a Settings-shaped home for it is a better one than a chat header.
   */
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
      if (id === conversationId) {
        setConversationId(null);
        // A question still in flight belongs to the thread that was just
        // deleted. Leaving it would put one turn under a blank chat, and its
        // Retry would file the answer into a conversation that is gone.
        pending.clear();
      }
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
  // `currentData`, for the third time in this file and the same reason. Removing
  // the folder chip skips this query, and a skipped query keeps its last result
  // in `data` — so the ids of a folder the user had just taken out of the
  // context would still be sent with the next question. That one is worse than
  // the chat showing a deleted thread, because nothing on screen says the
  // question was narrowed.
  const { currentData } = useGetProjectMeetingsQuery(only ?? "", { skip: !only });
  return React.useMemo(() => (currentData ?? []).map((m) => m.id), [currentData]);
}
