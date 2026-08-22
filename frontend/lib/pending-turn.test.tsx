import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePendingTurn } from "@/lib/pending-turn";
import type { ChatMessage } from "@/lib/types";

/**
 * The reconciliation rule, on its own.
 *
 * The surface test in `components/home-chat-panel.test.tsx` covers the ordinary
 * path. This covers the case that is awkward to reach through a UI and is
 * exactly where a content-matching implementation breaks: asking the same
 * question twice.
 */

function msg(id: string, role: "user" | "assistant", content: string): ChatMessage {
  return {
    id,
    conversationId: "cnv_1",
    role,
    content,
    citations: [],
    createdAt: "2026-08-21T08:00:00Z",
  };
}

describe("usePendingTurn", () => {
  it("holds the question from the moment it is sent", () => {
    const { result } = renderHook(() => usePendingTurn([]));

    act(() => result.current.begin("How can I register?"));

    expect(result.current.turn?.question).toBe("How can I register?");
    expect(result.current.turn?.status).toBe("asking");
  });

  it("lets go as soon as the server's copy arrives", () => {
    const { result, rerender } = renderHook(({ m }) => usePendingTurn(m), {
      initialProps: { m: [] as ChatMessage[] },
    });
    act(() => result.current.begin("How can I register?"));

    rerender({ m: [msg("msg_u", "user", "How can I register?"), msg("msg_a", "assistant", "…")] });

    expect(result.current.turn).toBeNull();
  });

  it("does not clear on a message the server already had", () => {
    // The thread is not empty when the second question is asked. Clearing on
    // "there is a user message" rather than "there is a *new* one" would make
    // the pending turn vanish on the render after it appeared.
    const existing = [msg("msg_1", "user", "First question"), msg("msg_2", "assistant", "…")];
    const { result, rerender } = renderHook(({ m }) => usePendingTurn(m), {
      initialProps: { m: existing },
    });

    act(() => result.current.begin("Second question"));
    rerender({ m: existing });

    expect(result.current.turn?.question).toBe("Second question");
  });

  it("survives asking the identical question twice", () => {
    const { result, rerender } = renderHook(({ m }) => usePendingTurn(m), {
      initialProps: { m: [] as ChatMessage[] },
    });

    act(() => result.current.begin("What was decided?"));
    const first = [msg("msg_1", "user", "What was decided?"), msg("msg_2", "assistant", "A.")];
    rerender({ m: first });
    expect(result.current.turn).toBeNull();

    // Same words, second time. Matching on content would clear this instantly
    // against the first exchange's message and the question would flash and
    // disappear; ids snapshotted at send time do not.
    act(() => result.current.begin("What was decided?"));
    rerender({ m: first });

    expect(result.current.turn?.question).toBe("What was decided?");

    rerender({ m: [...first, msg("msg_3", "user", "What was decided?")] });
    expect(result.current.turn).toBeNull();
  });

  it("keeps the question when the request fails", () => {
    const { result } = renderHook(() => usePendingTurn([]));
    act(() => result.current.begin("How can I register?"));

    act(() => result.current.fail());

    expect(result.current.turn?.status).toBe("failed");
    expect(result.current.turn?.question).toBe("How can I register?");
  });

  it("drops it outright when the thread is abandoned", () => {
    const { result } = renderHook(() => usePendingTurn([]));
    act(() => result.current.begin("How can I register?"));

    act(() => result.current.clear());

    expect(result.current.turn).toBeNull();
  });

  it("gives each turn a key of its own that no server id could collide with", () => {
    const { result } = renderHook(() => usePendingTurn([]));

    act(() => result.current.begin("one"));
    const first = result.current.turn!.id;
    act(() => result.current.begin("two"));

    expect(result.current.turn!.id).not.toBe(first);
    expect(first.startsWith("pending:")).toBe(true);
  });

  it("copes with a thread whose history has not loaded", () => {
    // `useGetChatQuery` is skipped until a conversation is named, so the first
    // question of a new chat begins with `messages` undefined.
    const { result, rerender } = renderHook(({ m }) => usePendingTurn(m), {
      initialProps: { m: undefined as ChatMessage[] | undefined },
    });

    act(() => result.current.begin("First ever question"));
    expect(result.current.turn?.question).toBe("First ever question");

    rerender({ m: [msg("msg_1", "user", "First ever question")] });
    expect(result.current.turn).toBeNull();
  });
});
