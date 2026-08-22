import { describe, it, expect, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, act } from "@testing-library/react";
import { activeChat, resetActiveChats, setActiveChat, useActiveChat } from "@/lib/active-chat";

/**
 * Which thread each chat surface is on, and how long it stays on it.
 *
 * **A thread belongs to one surface.** Home's rail and the full AI Chat page
 * read the same meetings through the same endpoints and are still two screens,
 * so they are keyed apart (`workspace:home`, `workspace:ask`). They shared one
 * key while Home's expand button navigated to /ask and the two had to be one
 * conversation; expanding widens the rail in place now.
 *
 * **A thread survives leaving the page.** Coming back to a meeting, or to Home,
 * returns you to what you were asking. Nothing is persisted, so a reload is the
 * reset.
 *
 * **`resetOnLeave` still exists and nothing uses it.** It was how the shared key
 * was contained — forgetting on unmount so neither surface could inherit the
 * other's thread — and keying them apart does that without the collateral. The
 * mechanism is kept, and tested below, because a surface that genuinely should
 * open blank every time is one word away.
 */

/** A surface that shows a scope's thread and can be unmounted like a page. */
function Surface({ scope, resetOnLeave }: { scope: string; resetOnLeave?: boolean }) {
  const [conversationId] = useActiveChat(scope, { resetOnLeave });
  return <p>{scope}: {conversationId ?? "new chat"}</p>;
}

beforeEach(() => {
  resetActiveChats();
});

describe("a surface that asks to be forgotten", () => {
  it("starts on a new chat", () => {
    render(<Surface scope="workspace" resetOnLeave />);

    expect(screen.getByText("workspace: new chat")).toBeInTheDocument();
  });

  it("stays on its thread while you are on the page", () => {
    render(<Surface scope="workspace" resetOnLeave />);

    act(() => setActiveChat("workspace", "cnv_1"));

    expect(screen.getByText("workspace: cnv_1")).toBeInTheDocument();
  });

  it("forgets the thread when the page goes", () => {
    const { unmount } = render(<Surface scope="workspace" resetOnLeave />);
    act(() => setActiveChat("workspace", "cnv_1"));

    // Navigating to Account Settings, or anywhere else.
    unmount();

    expect(activeChat("workspace")).toBeNull();
  });

  it("offers a new chat to the next surface that opens", () => {
    const first = render(<Surface scope="workspace" resetOnLeave />);
    act(() => setActiveChat("workspace", "cnv_1"));
    first.unmount();

    // Two surfaces sharing one key, which is what this flag was for. The
    // workspace chat no longer does that — see the block below — but the
    // mechanism still has to work for anything that opts in.
    render(<Surface scope="workspace" resetOnLeave />);

    expect(screen.getByText("workspace: new chat")).toBeInTheDocument();
  });
});

describe("the two workspace surfaces", () => {
  /*
   * Home and the full AI Chat page read the same meetings through the same
   * endpoints, and used to share one key — so a question asked in the rail
   * appeared on the page, and the page's answers appeared in the rail. That was
   * deliberate once: Home's expand button navigated to /ask, and losing the
   * thread there would have thrown away a half-typed question. Expanding widens
   * the rail in place now, so nothing was left holding it up.
   *
   * Keyed apart, they are independent. What stays shared is the archive — one
   * conversation list, one Clear all — which is why the keys share a prefix
   * rather than being unrelated strings.
   */

  it("does not show the rail's conversation on the full page", () => {
    render(<Surface scope="workspace:home" />);
    act(() => setActiveChat("workspace:home", "cnv_asked_on_home"));

    render(<Surface scope="workspace:ask" />);

    expect(screen.getByText("workspace:ask: new chat")).toBeInTheDocument();
    expect(activeChat("workspace:ask")).toBeNull();
  });

  it("does not show the full page's conversation in the rail", () => {
    render(<Surface scope="workspace:ask" />);
    act(() => setActiveChat("workspace:ask", "cnv_asked_on_ask"));

    render(<Surface scope="workspace:home" />);

    expect(screen.getByText("workspace:home: new chat")).toBeInTheDocument();
  });

  it("keeps each surface on its own thread at the same time", () => {
    render(
      <>
        <Surface scope="workspace:home" />
        <Surface scope="workspace:ask" />
      </>,
    );

    act(() => setActiveChat("workspace:home", "cnv_1"));
    act(() => setActiveChat("workspace:ask", "cnv_2"));

    expect(screen.getByText("workspace:home: cnv_1")).toBeInTheDocument();
    expect(screen.getByText("workspace:ask: cnv_2")).toBeInTheDocument();
  });

  it("keeps the rail's thread while you go and look at something else", () => {
    // The half `resetOnLeave` used to cost. Going to a meeting and coming back
    // to Home returned a clean sheet, because forgetting the thread on unmount
    // was the only thing stopping /ask from adopting it.
    const home = render(<Surface scope="workspace:home" />);
    act(() => setActiveChat("workspace:home", "cnv_1"));

    home.unmount();
    render(<Surface scope="workspace:home" />);

    expect(screen.getByText("workspace:home: cnv_1")).toBeInTheDocument();
  });

  it("starts both from a clean sheet on a reload", () => {
    act(() => setActiveChat("workspace:home", "cnv_1"));
    act(() => setActiveChat("workspace:ask", "cnv_2"));

    // Nothing is persisted — the store is a module-level map, so a page load is
    // the reset. `resetActiveChats` is that, made callable.
    act(() => resetActiveChats());

    expect(activeChat("workspace:home")).toBeNull();
    expect(activeChat("workspace:ask")).toBeNull();
  });
});

describe("a meeting's chat", () => {
  it("keeps its thread across leaving and coming back", () => {
    const visit = render(<Surface scope="mtg_1" />);
    act(() => setActiveChat("mtg_1", "cnv_9"));
    visit.unmount();

    render(<Surface scope="mtg_1" />);

    // Unchanged on purpose, and the thing most likely to be broken by a
    // careless change to the hook above: both scopes go through it.
    expect(screen.getByText("mtg_1: cnv_9")).toBeInTheDocument();
  });

  it("is untouched when the workspace chat forgets its own", () => {
    render(
      <>
        <Surface scope="mtg_1" />
        <Surface scope="workspace" resetOnLeave />
      </>,
    );
    act(() => {
      setActiveChat("mtg_1", "cnv_9");
      setActiveChat("workspace", "cnv_1");
    });

    // One scope leaving must not clear the map.
    expect(activeChat("mtg_1")).toBe("cnv_9");
    expect(activeChat("workspace")).toBe("cnv_1");
  });

  it("keeps one meeting's thread separate from another's", () => {
    render(
      <>
        <Surface scope="mtg_1" />
        <Surface scope="mtg_2" />
      </>,
    );

    act(() => setActiveChat("mtg_1", "cnv_9"));

    expect(screen.getByText("mtg_1: cnv_9")).toBeInTheDocument();
    expect(screen.getByText("mtg_2: new chat")).toBeInTheDocument();
  });
});
