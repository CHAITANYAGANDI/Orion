import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePendingTurn, resetPendingTurns } from "@/lib/pending-turn";
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

/**
 * The half that makes an answer survive walking away.
 *
 * <p>Answers take a while — a grounded question over a long meeting is a
 * retrieval, a rerank and a generation — and the natural thing to do while
 * waiting is go and look at something else. That unmounted the chat, and with
 * it the `useState` holding the question, so coming back showed an empty thread
 * with no sign that anything had been asked. The request itself was never
 * cancelled and the exchange was always persisted; it was the interface that
 * forgot.
 */
describe("surviving the page it was asked on", () => {
  beforeEach(() => resetPendingTurns());

  it("is still there after the component that asked is unmounted", () => {
    const first = renderHook(() => usePendingTurn([], "workspace:home"));
    act(() => first.result.current.begin("What did we decide?"));

    // Navigating away and back: a different component instance, same scope.
    first.unmount();
    const second = renderHook(() => usePendingTurn([], "workspace:home"));

    expect(second.result.current.turn?.question).toBe("What did we decide?");
    expect(second.result.current.turn?.status).toBe("asking");
  });

  it("keeps two surfaces' questions apart", () => {
    // Home and /ask are two screens. One's unanswered question has no business
    // appearing on the other, which is the same rule lib/active-chat applies to
    // the thread itself.
    const home = renderHook(() => usePendingTurn([], "workspace:home"));
    act(() => home.result.current.begin("Asked on Home"));

    const ask = renderHook(() => usePendingTurn([], "workspace:ask"));

    expect(ask.result.current.turn).toBeNull();
    expect(home.result.current.turn?.question).toBe("Asked on Home");
  });

  it("still reconciles against history fetched by a later mount", () => {
    const first = renderHook(() => usePendingTurn([], "meeting:mtg_1"));
    act(() => first.result.current.begin("What did we decide?"));
    first.unmount();

    // Coming back, the thread has been refetched and the question is in it.
    const second = renderHook(
      ({ m }) => usePendingTurn(m, "meeting:mtg_1"),
      { initialProps: { m: [msg("msg_1", "user", "What did we decide?")] } },
    );

    // Not shown twice: the persisted copy is the one on screen.
    expect(second.result.current.turn).toBeNull();
  });

  it("an unscoped turn still dies with its component", () => {
    // The old behaviour, kept for anything genuinely throwaway — and for the
    // tests above, which would otherwise leak into each other.
    const first = renderHook(() => usePendingTurn([]));
    act(() => first.result.current.begin("How can I register?"));
    first.unmount();

    const second = renderHook(() => usePendingTurn([]));

    expect(second.result.current.turn).toBeNull();
  });

  it("two components on one scope see the same question", () => {
    // The rail and the composer both read it, and a scope with two live readers
    // must not be two different pending turns.
    const a = renderHook(() => usePendingTurn([], "workspace:ask"));
    const b = renderHook(() => usePendingTurn([], "workspace:ask"));

    act(() => a.result.current.begin("Asked once"));

    expect(b.result.current.turn?.question).toBe("Asked once");
  });

  it("a failure is visible to whoever comes back to it", () => {
    const first = renderHook(() => usePendingTurn([], "workspace:home"));
    act(() => first.result.current.begin("What did we decide?"));
    act(() => first.result.current.fail());
    first.unmount();

    const second = renderHook(() => usePendingTurn([], "workspace:home"));

    // Kept with the failure under it rather than dropped, so Retry has
    // something to retry — the composer was cleared on send.
    expect(second.result.current.turn?.status).toBe("failed");
  });
});
