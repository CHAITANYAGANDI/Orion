import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatConversation, ChatMessage } from "@/lib/types";

/**
 * The workspace chat's handling of a conversation that disappears.
 *
 * This is a regression test for a real lock-up. Deleting the only exchange in a
 * thread also deletes the thread, and the page was still holding that thread's
 * id — so the refetch asked for a conversation that no longer existed, got a
 * 404, and every action afterwards failed. To the user the chat emptied itself
 * back to the starter prompts and then refused to delete anything, with an
 * error toast each time.
 *
 * Two defences are asserted here: acting on `conversationDeleted`, and healing
 * from a read error whatever caused it.
 */
const { chatQuery, deleteExchange, unwrap, createConversation, askChat } = vi.hoisted(() => ({
  chatQuery: vi.fn(),
  deleteExchange: vi.fn(),
  unwrap: vi.fn(),
  createConversation: vi.fn(),
  askChat: vi.fn(),
}));

let messages: ChatMessage[] = [];
let chatIsError = false;

vi.mock("@/lib/api", () => ({
  useGetWorkspaceChatQuery: (arg: unknown) => {
    chatQuery(arg);
    return { data: messages, isLoading: false, isError: chatIsError };
  },
  useGetWorkspaceConversationsQuery: () => ({ data: conversations }),
  useGetWorkspaceSuggestionsQuery: () => ({ data: undefined }),
  useAskWorkspaceChatMutation: () => [
    (a: unknown) => {
      askChat(a);
      return { unwrap: async () => message({ conversationId: "cnv_new" }) };
    },
    { isLoading: false },
  ],
  useClearWorkspaceChatMutation: () => [vi.fn(), { isLoading: false }],
  useCreateWorkspaceConversationMutation: () => [
    () => {
      createConversation();
      return { unwrap: async () => ({ id: "cnv_new" }) };
    },
    { isLoading: false },
  ],
  useRenameConversationMutation: () => [vi.fn(), {}],
  useDeleteConversationMutation: () => [vi.fn(), {}],
  useDeleteChatExchangeMutation: () => [
    (a: unknown) => {
      deleteExchange(a);
      return { unwrap };
    },
    { isLoading: false },
  ],
  // The composer's two extras. Neither is what this file is about, but the
  // page cannot mount without them — see lib/use-workspace-chat.
  useGetChatModesQuery: () => ({ data: [] }),
  useGetMeetingsQuery: () => ({ data: { content: [], page: 0, size: 0, totalElements: 0, totalPages: 0 } }),
  useGetProjectsQuery: () => ({ data: [] }),
  useGetProjectMeetingsQuery: () => ({ data: [] }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

let conversations: ChatConversation[] = [];

import { resetActiveChats, setActiveChat } from "@/lib/active-chat";

import AskPage from "@/app/(app)/ask/page";

function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "msg_1",
    conversationId: "cnv_1",
    role: "user",
    content: "What is still open?",
    citations: [],
    createdAt: "2026-08-15T09:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The thread a surface is on outlives a component, by design — it is what
  // lets the home rail and this page share a conversation. It must not outlive
  // a test.
  resetActiveChats();
  chatIsError = false;
  messages = [message(), message({ id: "msg_2", role: "assistant", content: "Three things." })];
  conversations = [
    {
      id: "cnv_1",
      meetingId: null,
      projectId: null,
      title: "Still open",
      messageCount: 2,
      createdAt: "2026-08-15T09:00:00Z",
      updatedAt: "2026-08-15T09:00:00Z",
    },
  ];
  unwrap.mockResolvedValue({ deletedMessages: 2, conversationDeleted: false });
});

/** The `conversationId` the page most recently asked the chat query for. */
function lastQueryArg() {
  return chatQuery.mock.calls.at(-1)?.[0];
}

describe("AskPage conversation state", () => {
  it("opens a new chat rather than resuming the last one", async () => {
    render(<AskPage />);

    // Changed deliberately. This used to assert that the page adopted the most
    // recent thread on open, which is what it did: reading history without
    // naming a thread returns the latest one, so every visit landed in a
    // conversation from days ago and a clean sheet was a button press you had
    // to know to look for.
    //
    // Nothing is read until a thread is chosen or a question creates one, and
    // the picker says so rather than naming a conversation you are not in.
    await waitFor(() => expect(screen.getByText("New chat")).toBeInTheDocument());
    expect(lastQueryArg()).toBeUndefined();
    expect(chatQuery).not.toHaveBeenCalledWith({ conversationId: "cnv_1" });
  });

  it("gives the first question a thread of its own", async () => {
    // Not just a cosmetic blank page. The server's rule for a question with no
    // thread named is "continue the most recent, or start one" — so a clean
    // sheet on screen would quietly append to the old conversation, which is
    // worse than resuming it openly.
    render(<AskPage />);

    await userEvent.type(
      screen.getByPlaceholderText(/ask/i),
      "What is still open?{Enter}",
    );

    await waitFor(() => expect(createConversation).toHaveBeenCalled());
    expect(askChat).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "cnv_new" }),
    );
  });

  it("keeps reading the thread once one is chosen", async () => {
    // The other half: starting fresh must not mean the picker stops working.
    setActiveChat("workspace", "cnv_1");
    render(<AskPage />);

    await waitFor(() => expect(lastQueryArg()).toEqual({ conversationId: "cnv_1" }));
  });

  it("drops the thread when deleting emptied it", async () => {
    // The delete invalidates the chat, and the refetch no longer has those
    // messages or that thread — modelled here, because a mock that kept
    // serving the deleted thread would let the page correctly re-adopt it and
    // the test would be asserting against a state the server cannot produce.
    unwrap.mockImplementation(async () => {
      messages = [];
      conversations = [];
      return { deletedMessages: 2, conversationDeleted: true };
    });
    setActiveChat("workspace", "cnv_1");
    render(<AskPage />);
    await waitFor(() => expect(lastQueryArg()).toEqual({ conversationId: "cnv_1" }));

    await userEvent.click(screen.getAllByRole("button", { name: /delete this exchange/i })[0]);

    // The thread went with the exchange. Keeping its id is what made every
    // later request 404.
    await waitFor(() => expect(lastQueryArg()).toBeUndefined());
  });

  it("lands on a clean sheet rather than an older thread when one is emptied", async () => {
    // Changed deliberately. This used to assert that the page moved to the
    // remaining thread, reached by dropping the id and letting an unscoped
    // read return the most recent one. That is the same "resumed into an old
    // conversation" behaviour AI Chat now avoids everywhere else, and it is
    // more startling here than on open — the thread arrives unasked, in
    // response to a delete.
    //
    // The remaining thread is not lost; it is one click away in the picker.
    unwrap.mockImplementation(async () => {
      messages = [message({ id: "msg_9", conversationId: "cnv_2", content: "Older question" })];
      conversations = [{ ...conversations[0], id: "cnv_2", title: "Older" }];
      return { deletedMessages: 2, conversationDeleted: true };
    });
    setActiveChat("workspace", "cnv_1");
    render(<AskPage />);
    await waitFor(() => expect(lastQueryArg()).toEqual({ conversationId: "cnv_1" }));

    await userEvent.click(screen.getAllByRole("button", { name: /delete this exchange/i })[0]);

    await waitFor(() => expect(lastQueryArg()).toBeUndefined());
    expect(await screen.findByText("New chat")).toBeInTheDocument();
  });

  it("keeps the thread when other exchanges remain", async () => {
    unwrap.mockResolvedValue({ deletedMessages: 2, conversationDeleted: false });
    setActiveChat("workspace", "cnv_1");
    render(<AskPage />);
    await waitFor(() => expect(lastQueryArg()).toEqual({ conversationId: "cnv_1" }));

    await userEvent.click(screen.getAllByRole("button", { name: /delete this exchange/i })[0]);

    // Resetting here would jump the user out of the thread they are reading.
    await waitFor(() =>
      expect(deleteExchange).toHaveBeenCalledWith({ messageId: "msg_1", scope: "ME" }),
    );
    expect(lastQueryArg()).toEqual({ conversationId: "cnv_1" });
  });

  it("heals from a thread that vanished some other way", async () => {
    // Another tab, a stale id, a thread emptied elsewhere. Without this the
    // chat is stuck on 404 with no way out but a reload.
    setActiveChat("workspace", "cnv_1");
    const { rerender } = render(<AskPage />);
    await waitFor(() => expect(lastQueryArg()).toEqual({ conversationId: "cnv_1" }));

    chatIsError = true;
    messages = [];
    rerender(<AskPage />);

    await waitFor(() => expect(lastQueryArg()).toBeUndefined());
  });

  it("does not loop when the unscoped read also fails", async () => {
    // The guard only fires while an id is held, so a server that is simply down
    // must not spin this effect.
    chatIsError = true;
    messages = [];
    conversations = [];
    render(<AskPage />);

    await waitFor(() => expect(lastQueryArg()).toBeUndefined());
    const calls = chatQuery.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(chatQuery.mock.calls.length).toBe(calls);
  });
});
