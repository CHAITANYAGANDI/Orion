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
  const store: { messages: ChatMessage[] } = { messages: [] };
  return {
    store,
    listeners,
    /** Stand in for the tag invalidation that refetches the thread. */
    persist(messages: ChatMessage[]) {
      store.messages = messages;
      listeners.forEach((l) => l());
    },
    reset() {
      store.messages = [];
      listeners.forEach((l) => l());
    },
    /** Resolves the held ask. Set fresh by each test that needs one. */
    settle: null as null | ((value?: unknown) => void),
    reject: null as null | ((reason?: unknown) => void),
    asked: [] as string[],
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

  function useMessages() {
    return React_.useSyncExternalStore(
      (l: () => void) => {
        api.listeners.add(l);
        return () => api.listeners.delete(l);
      },
      () => api.store.messages,
      () => api.store.messages,
    );
  }

  const empty = () => ({ data: undefined });
  const noop = () => [() => ({ unwrap: () => Promise.resolve({}) }), {}];

  return {
    useGetWorkspaceChatQuery: () => ({ data: useMessages(), isLoading: false, isError: false }),
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
    useGetWorkspaceConversationsQuery: () => ({ data: [] }),
    useCreateWorkspaceConversationMutation: () => [
      () => {
        api.conversationsCreated += 1;
        return { unwrap: () => Promise.resolve({ id: "cnv_1" }) };
      },
      { isLoading: false },
    ],
    useClearWorkspaceChatMutation: noop,
    useRenameConversationMutation: noop,
    useDeleteConversationMutation: noop,
    useDeleteChatExchangeMutation: noop,
    useGetChatModesQuery: () => ({ data: [] }),
    useGetMeetingsQuery: empty,
    useGetProjectsQuery: empty,
    useGetProjectMeetingsQuery: empty,
  };
});

import { HomeChatPanel } from "@/components/home-chat-panel";
import { resetActiveChats } from "@/lib/active-chat";
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
  api.reset();
  api.settle = null;
  api.reject = null;
  api.asked = [];
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
