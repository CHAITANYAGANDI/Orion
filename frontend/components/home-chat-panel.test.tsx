import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatMessage } from "@/lib/types";

/**
 * The question you asked, while it is being answered.
 *
 * ## The bug
 *
 * Send emptied the composer and the rail showed "Searching the transcript…"
 * with nothing above it. For the five to ten seconds an answer takes, the only
 * evidence that anything had been asked was a spinner: the question had left
 * the box and had not arrived anywhere. It appeared later, above the answer, as
 * though it had been there all along.
 *
 * The cause was that the question existed only as server state. Nothing held it
 * between `submit()` clearing the input and the tag invalidation refetching the
 * thread, so there was nothing to draw.
 *
 * ## What is tested here
 *
 * The whole surface, with the request deliberately held open — because the
 * failure is entirely about the window between the click and the response, and
 * a test of `usePendingTurn` alone would pass with the component still not
 * rendering it.
 *
 * The other half is the reconciliation: exactly one copy of the question after
 * the server's arrives. That is what makes the naive fix — render the question
 * in a second div and never remove it — visible.
 */

const api = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const store: {
    messages: ChatMessage[];
    conversations: { id: string; title: string; updatedAt: string }[];
  } = { messages: [], conversations: [] };
  return {
    store,
    listeners,
    /** Stand in for the tag invalidation that refetches the thread. */
    persist(messages: ChatMessage[]) {
      store.messages = messages;
      listeners.forEach((l) => l());
    },
    /** The thread as the history picker sees it. */
    listConversation(id: string, title: string) {
      store.conversations = [
        ...store.conversations,
        { id, title, updatedAt: "2026-08-21T08:00:05Z" },
      ];
      listeners.forEach((l) => l());
    },
    reset() {
      store.messages = [];
      store.conversations = [];
      this.lastChatData = undefined;
      listeners.forEach((l) => l());
    },
    /**
     * What RTK Query would still be holding in `data`.
     *
     * Not decoration: `queryStatePreSelector` keeps the last successful result
     * in `data` when a query becomes *skipped*, deliberately, so that a query
     * which skips and un-skips does not flash empty. The chat uses skip to mean
     * "no thread is open", so that retention is what kept a deleted
     * conversation on screen. A mock that dropped the data on skip would make
     * the bug untestable.
     */
    lastChatData: undefined as ChatMessage[] | undefined,
    /** Resolves the held ask. Set fresh by each test that needs one. */
    settle: null as null | ((value?: unknown) => void),
    reject: null as null | ((reason?: unknown) => void),
    asked: [] as string[],
    deleted: [] as string[],
    deletedExchanges: [] as string[],
    conversationsCreated: 0,
  };
});

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

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

vi.mock("@/lib/api", () => {
  const React_ = require("react") as typeof import("react");

  function useStore<T>(read: () => T) {
    return React_.useSyncExternalStore(
      (l: () => void) => {
        api.listeners.add(l);
        return () => api.listeners.delete(l);
      },
      read,
      read,
    );
  }

  const empty = () => ({ data: undefined });
  const noop = () => [() => ({ unwrap: () => Promise.resolve({}) }), {}];

  return {
    useGetWorkspaceChatQuery: (_arg: unknown, options?: { skip?: boolean }) => {
      const messages = useStore(() => api.store.messages);
      const skipped = Boolean(options?.skip);
      // The real hook's two fields, told apart. `currentData` belongs to the
      // cache entry currently selected -- and a skipped query has none.
      if (!skipped) api.lastChatData = messages;
      return {
        data: api.lastChatData,
        currentData: skipped ? undefined : messages,
        isFetching: false,
        isError: false,
      };
    },
    useGetWorkspaceSuggestionsQuery: () => ({
      data: { suggestions: ["What is still open across my meetings?"] },
    }),
    useAskWorkspaceChatMutation: () => [
      (body: { question: string }) => {
        api.asked.push(body.question);
        return {
          unwrap: () =>
            new Promise((resolve, reject) => {
              api.settle = (v) => resolve(v ?? { conversationId: "cnv_1" });
              api.reject = reject;
            }),
        };
      },
      { isLoading: false },
    ],
    useGetWorkspaceConversationsQuery: () => ({
      data: useStore(() => api.store.conversations),
    }),
    useCreateWorkspaceConversationMutation: () => [
      () => {
        api.conversationsCreated += 1;
        return { unwrap: () => Promise.resolve({ id: "cnv_1" }) };
      },
      { isLoading: false },
    ],
    useClearWorkspaceChatMutation: noop,
    useRenameConversationMutation: noop,
    useDeleteConversationMutation: () => [
      ({ conversationId }: { conversationId: string }) => {
        api.deleted.push(conversationId);
        // The row goes from the picker. The messages deliberately do not: the
        // panel stops asking for them rather than being told they are gone,
        // and that is the path the bug lived on.
        api.store.conversations = api.store.conversations.filter(
          (c) => c.id !== conversationId,
        );
        api.listeners.forEach((l) => l());
        return { unwrap: () => Promise.resolve({}) };
      },
      { isLoading: false },
    ],
    useDeleteChatExchangeMutation: () => [
      ({ messageId }: { messageId: string }) => {
        api.deletedExchanges.push(messageId);
        return {
          unwrap: () =>
            Promise.resolve({ deletedMessages: 2, conversationDeleted: false }),
        };
      },
      { isLoading: false },
    ],
    useGetChatModesQuery: () => ({ data: [] }),
    useGetMeetingsQuery: empty,
    useGetProjectsQuery: empty,
    useGetProjectMeetingsQuery: empty,
  };
});

import { HomeChatPanel } from "@/components/home-chat-panel";
import { resetActiveChats } from "@/lib/active-chat";
import { resetPendingTurns } from "@/lib/pending-turn";
import { resetPromptRotation } from "@/lib/use-rotating-prompts";

const QUESTION = "How can I register?";

function persistedExchange(question: string, answer: string): ChatMessage[] {
  return [
    {
      id: "msg_u",
      conversationId: "cnv_1",
      role: "user",
      content: question,
      citations: [],
      createdAt: "2026-08-21T08:00:00Z",
    },
    {
      id: "msg_a",
      conversationId: "cnv_1",
      role: "assistant",
      content: answer,
      citations: [],
      createdAt: "2026-08-21T08:00:05Z",
    },
  ];
}

async function ask(question = QUESTION) {
  await userEvent.type(screen.getByLabelText("Ask a question"), question);
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
}

beforeEach(() => {
  // The open thread now outlives unmount — it is keyed per surface rather than
  // cleared on leaving, see lib/active-chat — so one test's conversation would
  // otherwise be adopted by the next, and `send` would skip creating one.
  resetActiveChats();
  // The suggestion row rotates, and its offset outlives an unmount too — so
  // without this each test would start further into the pool than the last and
  // the chip it clicks would have scrolled off the row.
  resetPromptRotation();
  // And the question in flight, for the same reason as the thread: it is held
  // in a module store now so that leaving the page does not lose the answer,
  // which means one test's unanswered question is still pending in the next --
  // and a pending turn hides the starter chips this file clicks on.
  resetPendingTurns();
  api.reset();
  api.settle = null;
  api.reject = null;
  api.asked = [];
  api.deleted = [];
  api.deletedExchanges = [];
  api.conversationsCreated = 0;
});

describe("a question in flight", () => {
  it("shows the question immediately, and says Thinking", async () => {
    render(<HomeChatPanel />);

    await ask();

    // Before anything resolves. This is the whole bug: the question left the
    // composer and used to arrive nowhere.
    await screen.findByText(QUESTION);
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    // The old line described a step that does not always happen — a question
    // the action-item ledger answers searches no transcript at all.
    expect(screen.queryByText(/Searching the transcript/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Searching across your meetings/i)).not.toBeInTheDocument();
  });

  it("keeps the question on screen exactly once when the answer arrives", async () => {
    render(<HomeChatPanel />);
    await ask();
    await screen.findByText(QUESTION);

    await act(async () => {
      api.persist(persistedExchange(QUESTION, "The transcript has no link."));
      api.settle!();
    });

    await screen.findByText("The transcript has no link.");
    // The naive fix — draw the question in a second div and leave it there —
    // passes every other assertion in this file and fails this one.
    expect(screen.getAllByText(QUESTION)).toHaveLength(1);
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
  });

  it("does not flash the question twice at the moment of reconciliation", async () => {
    render(<HomeChatPanel />);
    await ask();
    await screen.findByText(QUESTION);

    // Both at once, which is what an invalidation-driven refetch does: the
    // persisted turn lands before anything clears the pending one. Resolved in
    // the same render rather than in an effect, so there is no frame in which
    // both are on screen.
    await act(async () => api.persist(persistedExchange(QUESTION, "An answer.")));

    await waitFor(() => expect(screen.getAllByText(QUESTION)).toHaveLength(1));
  });

  it("hides the starter prompts while the answer is being written", async () => {
    render(<HomeChatPanel />);
    expect(screen.getByText("What is still open across my meetings?")).toBeInTheDocument();

    await ask();

    // Three disabled pills across half a four-hundred-pixel rail, sitting where
    // the answer is about to appear.
    await waitFor(() =>
      expect(
        screen.queryByText("What is still open across my meetings?"),
      ).not.toBeInTheDocument(),
    );
  });
});

describe("a question that came from somewhere other than the box", () => {
  it("shows a suggestion chip's question the same way", async () => {
    render(<HomeChatPanel />);

    await userEvent.click(
      screen.getByRole("button", { name: "What is still open across my meetings?" }),
    );

    // Same treatment however the question was raised — typed, tapped, or sent
    // over from a transcript selection. The chip's text is now the prompt.
    expect(await screen.findByText("What is still open across my meetings?")).toBeInTheDocument();
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    expect(api.asked).toEqual(["What is still open across my meetings?"]);
  });

  it("reconciles a chip's question without duplicating it either", async () => {
    render(<HomeChatPanel />);
    const chip = "What is still open across my meetings?";

    await userEvent.click(screen.getByRole("button", { name: chip }));
    await screen.findByText("Thinking…");
    await act(async () => {
      api.persist(persistedExchange(chip, "Four things."));
      api.settle!();
    });

    await screen.findByText("Four things.");
    expect(screen.getAllByText(chip)).toHaveLength(1);
  });
});

describe("the first question in a brand-new thread", () => {
  it("stays visible while the conversation is being created", async () => {
    render(<HomeChatPanel />);

    await ask();

    // A new chat has no thread id, so `send` creates one before it can ask.
    // The question must survive that extra round trip — it is the longest
    // window in which the old build showed nothing.
    expect(await screen.findByText(QUESTION)).toBeInTheDocument();
    await waitFor(() => expect(api.conversationsCreated).toBe(1));
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
  });

  it("creates one conversation, not one per render", async () => {
    render(<HomeChatPanel />);

    await ask();
    await waitFor(() => expect(api.asked).toHaveLength(1));

    expect(api.conversationsCreated).toBe(1);
  });
});

describe("when the request fails", () => {
  it("keeps the question and says so, rather than dropping both", async () => {
    render(<HomeChatPanel />);
    await ask();
    await screen.findByText("Thinking…");

    await act(async () => api.reject!(new Error("gateway")));

    expect(await screen.findByText("Couldn't get an answer.")).toBeInTheDocument();
    // The composer was cleared on send. Discarding the question here means
    // retyping it.
    expect(screen.getByText(QUESTION)).toBeInTheDocument();
    // And no spinner left running over a request that is over.
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
  });

  it("retries the same question", async () => {
    render(<HomeChatPanel />);
    await ask();
    await screen.findByText("Thinking…");
    await act(async () => api.reject!(new Error("gateway")));
    await screen.findByText("Couldn't get an answer.");

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(api.asked).toEqual([QUESTION, QUESTION]);
    expect(await screen.findByText("Thinking…")).toBeInTheDocument();
  });
});

describe("deleting the conversation you are reading", () => {
  /**
   * ## The bug
   *
   * Delete the thread on screen and it stayed on screen. The messages were
   * still drawn, the starter prompts did not come back, and "New chat" was
   * still offered as though you were somewhere else -- so the only way to a
   * clean sheet was to press New on a conversation that no longer existed.
   *
   * The cause was one field. `remove` sets the thread id to null, which skips
   * the history query, and RTK Query *keeps the last successful result in
   * `data` when a query is skipped* -- by design, so a query that skips and
   * un-skips does not flash empty. This chat uses skip to mean "no thread is
   * open", so the deleted conversation's messages went on being served from a
   * cache entry nothing was subscribed to.
   */
  async function askAndPersist() {
    render(<HomeChatPanel />);
    await ask();
    await act(async () => {
      api.persist(persistedExchange(QUESTION, "The transcript has no link."));
      api.listConversation("cnv_1", QUESTION);
      api.settle!();
    });
    await screen.findByText("The transcript has no link.");
  }

  async function deleteFromPicker() {
    await userEvent.click(screen.getByRole("button", { name: "Previous chat history" }));
    await userEvent.click(screen.getByRole("button", { name: `Delete ${QUESTION}` }));
  }

  it("empties the thread instead of leaving the deleted conversation on screen", async () => {
    await askAndPersist();

    await deleteFromPicker();

    await waitFor(() => expect(api.deleted).toEqual(["cnv_1"]));
    expect(screen.queryByText("The transcript has no link.")).toBeNull();
    expect(screen.queryByText(QUESTION)).toBeNull();
  });

  it("offers the starter prompts again, which is what an empty chat looks like", async () => {
    await askAndPersist();

    await deleteFromPicker();

    expect(
      await screen.findByText("What is still open across my meetings?"),
    ).toBeInTheDocument();
  });

  it("says you are already on a new chat, rather than offering to start one", async () => {
    await askAndPersist();
    // While the thread is up, New is a real action.
    expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled();

    await deleteFromPicker();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled(),
    );
  });

  it("leaves an unrelated thread alone", async () => {
    await askAndPersist();
    api.listConversation("cnv_2", "Something else");

    await userEvent.click(screen.getByRole("button", { name: "Previous chat history" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete Something else" }));

    // Deleting a thread you are not in must not clear the one you are.
    await waitFor(() => expect(api.deleted).toEqual(["cnv_2"]));
    expect(screen.getByText("The transcript has no link.")).toBeInTheDocument();
  });
});

describe("a starter chip that is an opening rather than a question", () => {
  /**
   * ## The bug
   *
   * Two of the six workspace prompts end in a space -- "Find every discussion
   * about ", "What did " -- because the user is meant to finish them. Sending
   * one as written would ask the model to search for nothing, so
   * `ChatSuggestions` routes those to `onCompose` instead of `onSend`.
   *
   * This rail, and the full AI Chat page, both passed `() => undefined` for
   * that. So those two chips were drawn, were not disabled, and did nothing
   * whatsoever when clicked. The meeting page had it wired correctly the whole
   * time, which is why it only ever showed up on two surfaces.
   */
  const OPENING = "Find a mention";

  async function showTheSecondRow() {
    // The row rotates by three per visit, and the openings are further down
    // the pool than the first three. Mounting once and again is how a second
    // visit is spelled -- see lib/use-rotating-prompts, where the offset is
    // advanced in an effect so the row you are looking at never moves.
    render(<HomeChatPanel />).unmount();
    render(<HomeChatPanel />);
    await screen.findByRole("button", { name: OPENING });
  }

  it("puts it in the composer for the user to finish", async () => {
    await showTheSecondRow();

    await userEvent.click(screen.getByRole("button", { name: OPENING }));

    expect(screen.getByLabelText("Ask a question")).toHaveValue(
      "Find every discussion about ",
    );
  });

  it("does not send it, because it is not yet a question", async () => {
    await showTheSecondRow();

    await userEvent.click(screen.getByRole("button", { name: OPENING }));

    expect(api.asked).toEqual([]);
    expect(api.conversationsCreated).toBe(0);
  });

  it("still sends a chip that is a whole question", async () => {
    await showTheSecondRow();

    // The third chip in the same row, so the two paths are compared under
    // identical conditions: one lands in the box, the other is sent.
    await userEvent.click(
      screen.getByRole("button", { name: "Compare selected meetings" }),
    );

    await waitFor(() => expect(api.asked).toHaveLength(1));
    expect(api.asked[0]).toMatch(/^Compare the meetings I have selected/);
    expect(screen.getByLabelText("Ask a question")).toHaveValue("");
  });
});

describe("withdrawing a question from the rail", () => {
  /**
   * Two things were wrong with where the bin was.
   *
   * It was drawn under the *answer* on the two surfaces that had it, and
   * deleting an answer is not something the API can do -- the server removes the
   * pair. So the control read as "clear this bad reply" and quietly took the
   * question with it.
   *
   * And this rail had no bin at all. It was on the list of things a
   * four-hundred-pixel column drops, which was the wrong call: it is an icon
   * that appears on hover under your own question and costs no width, and
   * without it a question asked here could only be withdrawn by opening
   * another screen.
   */
  async function askAndPersist() {
    render(<HomeChatPanel />);
    await ask();
    await act(async () => {
      api.persist(persistedExchange(QUESTION, "The transcript has no link."));
      api.listConversation("cnv_1", QUESTION);
      api.settle!();
    });
    await screen.findByText("The transcript has no link.");
  }

  it("offers a bin under the question", async () => {
    await askAndPersist();

    expect(
      screen.getByRole("button", { name: /delete this exchange/i }),
    ).toBeInTheDocument();
  });

  it("offers exactly one, not one per turn", async () => {
    await askAndPersist();

    // Two bubbles are on screen. Only the question carries the control, so a
    // bin never sits under an answer promising something it cannot do.
    expect(screen.getAllByRole("button", { name: /delete this exchange/i })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Copy answer" })).toBeInTheDocument();
  });

  it("sends the question's id, which is what the server pairs from", async () => {
    await askAndPersist();

    await userEvent.click(screen.getByRole("button", { name: /delete this exchange/i }));

    await waitFor(() => expect(api.deletedExchanges).toEqual(["msg_u"]));
  });
});
