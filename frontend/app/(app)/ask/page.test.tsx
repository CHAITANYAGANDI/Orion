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
const { chatQuery, deleteExchange, unwrap } = vi.hoisted(() => ({
  chatQuery: vi.fn(),
  deleteExchange: vi.fn(),
  unwrap: vi.fn(),
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
  useAskWorkspaceChatMutation: () => [vi.fn(), { isLoading: false }],
  useClearWorkspaceChatMutation: () => [vi.fn(), { isLoading: false }],
  useCreateWorkspaceConversationMutation: () => [vi.fn(), { isLoading: false }],
  useRenameConversationMutation: () => [vi.fn(), {}],
  useDeleteConversationMutation: () => [vi.fn(), {}],
  useDeleteChatExchangeMutation: () => [
    (a: unknown) => {
      deleteExchange(a);
      return { unwrap };
    },
    { isLoading: false },
  ],
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

let conversations: ChatConversation[] = [];

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
  it("adopts the thread its messages came from", async () => {
    render(<AskPage />);
    // Asking without naming a thread continues the most recent one, and only
    // the response says which — the picker would otherwise stay generic.
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
    render(<AskPage />);
    await waitFor(() => expect(lastQueryArg()).toEqual({ conversationId: "cnv_1" }));

    await userEvent.click(screen.getAllByRole("button", { name: /delete this exchange/i })[0]);

    // The thread went with the exchange. Keeping its id is what made every
    // later request 404.
    await waitFor(() => expect(lastQueryArg()).toBeUndefined());
  });

  it("moves to the remaining thread when one is left", async () => {
    // Not the same as the case above: the id must not be kept, but nor should
    // the page sit unscoped when there is a thread to show.
    unwrap.mockImplementation(async () => {
      messages = [message({ id: "msg_9", conversationId: "cnv_2", content: "Older question" })];
      conversations = [{ ...conversations[0], id: "cnv_2", title: "Older" }];
      return { deletedMessages: 2, conversationDeleted: true };
    });
    render(<AskPage />);
    await waitFor(() => expect(lastQueryArg()).toEqual({ conversationId: "cnv_1" }));

    await userEvent.click(screen.getAllByRole("button", { name: /delete this exchange/i })[0]);

    await waitFor(() => expect(lastQueryArg()).toEqual({ conversationId: "cnv_2" }));
  });

  it("keeps the thread when other exchanges remain", async () => {
    unwrap.mockResolvedValue({ deletedMessages: 2, conversationDeleted: false });
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
