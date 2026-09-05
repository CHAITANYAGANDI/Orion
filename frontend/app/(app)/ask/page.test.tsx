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
/** What RTK Query would still be holding in `data` after a skip. */
let lastChatData: ChatMessage[] | undefined;

/**
 * The allowance the composer reads. Full, so these stay about chat.
 * `lib/allowance.test.ts` and `chat-composer.test.tsx` cover the spent case.
 */
vi.mock("@/lib/allowance", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/allowance")>();
  return {
    ...real,
    useAllowance: () => ({
      loading: false,
      unknown: false,
      minutesLeft: 100,
      importsLeft: 3,
      secondsLeft: 6000,
      canRecord: true,
      canImport: true,
    }),
  };
});

vi.mock("@/lib/api", () => ({
  // `currentData` and `isFetching` are what the page reads, and the pair is
  // modelled rather than collapsed into one field. RTK Query keeps the last
  // successful result in `data` when a query becomes *skipped* — which is how
  // this chat says "no thread is open" — so a mock that served `messages` from
  // both would hide the very state these tests are about.
  useGetWorkspaceChatQuery: (arg: unknown, options?: { skip?: boolean }) => {
    chatQuery(arg);
    const skipped = Boolean(options?.skip);
    if (!skipped) lastChatData = messages;
    return {
      data: lastChatData,
      currentData: skipped ? undefined : messages,
      isFetching: false,
      isError: chatIsError,
    };
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
import { resetPromptRotation } from "@/lib/use-rotating-prompts";

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
  // The suggestion row rotates, and its offset is module state that outlives an
  // unmount. Without this each test starts further into the pool than the last.
  resetPromptRotation();
  chatIsError = false;
  lastChatData = undefined;
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

describe("AskPage header", () => {
  it("offers no Clear all", () => {
    render(<AskPage />);

    // It deleted every conversation in the workspace archive — this page's and
    // the Home rail's, which this page never lists — from a header whose other
    // controls switch threads and start one. Deleting a thread at a time from
    // the picker, or an exchange from the message it belongs to, both survive.
    expect(screen.queryByRole("button", { name: /clear all/i })).not.toBeInTheDocument();
  });

  it("still gets you to another thread and to a new one", () => {
    render(<AskPage />);

    expect(screen.getByRole("button", { name: /previous chat history/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^new chat$/i })).toBeInTheDocument();
  });
});

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

  it("offers no New when the chat on screen is already a new one", async () => {
    messages = [];
    render(<AskPage />);

    // Pressing it would file an empty conversation into the history list and
    // leave the screen exactly as it was.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /new chat/i })).toBeDisabled(),
    );
  });

  it("offers New once the thread has something in it", async () => {
    setActiveChat("workspace:ask", "cnv_1");
    render(<AskPage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /new chat/i })).toBeEnabled(),
    );
  });

  it("keeps reading the thread once one is chosen", async () => {
    // The other half: starting fresh must not mean the picker stops working.
    setActiveChat("workspace:ask", "cnv_1");
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
    setActiveChat("workspace:ask", "cnv_1");
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
    setActiveChat("workspace:ask", "cnv_1");
    render(<AskPage />);
    await waitFor(() => expect(lastQueryArg()).toEqual({ conversationId: "cnv_1" }));

    await userEvent.click(screen.getAllByRole("button", { name: /delete this exchange/i })[0]);

    await waitFor(() => expect(lastQueryArg()).toBeUndefined());
    expect(await screen.findByText("New chat")).toBeInTheDocument();
  });

  it("keeps the thread when other exchanges remain", async () => {
    unwrap.mockResolvedValue({ deletedMessages: 2, conversationDeleted: false });
    setActiveChat("workspace:ask", "cnv_1");
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
    setActiveChat("workspace:ask", "cnv_1");
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

describe("a starter chip that is an opening rather than a question", () => {
  /**
   * Two of the six workspace prompts end in a space -- "Find every discussion
   * about ", "What did " -- because the reader finishes them. Sending one as
   * written would ask the model to search for nothing, so `ChatSuggestions`
   * routes them to `onCompose` instead of `onSend`.
   *
   * This page passed `() => undefined` for that, so those two chips were drawn,
   * were not disabled, and did nothing at all when clicked. Asserted here as
   * well as on the Home rail because the wiring is per surface: the shared hook
   * has no say in it, and the meeting page had it right the whole time.
   */
  async function showTheSecondRow() {
    messages = [];
    conversations = [];
    // The row moves along by three per visit, and the openings sit below the
    // first three. Mounting twice is how a second visit is spelled -- see
    // lib/use-rotating-prompts, where the offset is advanced in an effect so
    // the row on screen never moves under the cursor.
    render(<AskPage />).unmount();
    render(<AskPage />);
    await screen.findByRole("button", { name: "Find a mention" });
  }

  it("puts it in the composer instead of sending it", async () => {
    await showTheSecondRow();

    await userEvent.click(screen.getByRole("button", { name: "Find a mention" }));

    expect(screen.getByLabelText("Ask a question")).toHaveValue(
      "Find every discussion about ",
    );
    expect(askChat).not.toHaveBeenCalled();
    expect(createConversation).not.toHaveBeenCalled();
  });

  it("still sends the chip beside it, which is a whole question", async () => {
    await showTheSecondRow();

    await userEvent.click(
      screen.getByRole("button", { name: "Conflicting decisions" }),
    );

    await waitFor(() => expect(askChat).toHaveBeenCalled());
    expect(askChat.mock.calls[0][0].question).toMatch(/^Do any decisions/);
  });
});

/**
 * The column the thread is set in.
 *
 * <p>Not a rounder number for its own sake. 680px at the reading size is about
 * 74 characters, which is the measurement the whole V2 layout is built to
 * protect — and it is the same column a transcript and a brief are set in, so
 * moving between them is not a change of reading posture.
 *
 * <p>Both regions are pinned, because they have drifted apart before: the
 * thread at one width and the composer at another gives the box a visible step
 * relative to the answer above it, which reads as a rendering fault.
 */
describe("the measure", () => {
  it("holds the thread and the composer to the same column", () => {
    const { container } = render(<AskPage />);

    const columns = container.querySelectorAll(".max-w-measure");
    expect(columns).toHaveLength(2);
  });

  it("does not hold the thread picker to it", () => {
    // Deliberate. Its two jobs are "which conversation am I in" and "start
    // another", and those belong in the corners the eye already goes to rather
    // than boxed in with the prose.
    const { container } = render(<AskPage />);

    const header = container.querySelector("header");
    expect(header?.querySelector(".max-w-measure")).toBeNull();
  });

  it("sizes itself against the band rather than a hardcoded header", () => {
    // The chrome above is 48px and is published as `--band`. A page that
    // hardcodes the old 4rem scrolls its own composer off the bottom.
    const { container } = render(<AskPage />);

    expect(container.innerHTML).toContain("100vh-var(--band)");
  });
});
