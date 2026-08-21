import { describe, it, expect, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, act } from "@testing-library/react";
import { activeChat, resetActiveChats, setActiveChat, useActiveChat } from "@/lib/active-chat";

/**
 * Which thread each chat surface is on, and how long it stays on it.
 *
 * The two rules here pull in opposite directions and are both deliberate, so
 * they are written down together.
 *
 * **The workspace chat forgets.** Going to Account Settings and coming back to
 * Home must be a clean sheet, not yesterday's questions still on screen. It
 * used to persist, because the home rail's expand button navigated to /ask and
 * losing the thread would have meant that control abandoning a half-typed
 * question. Expanding happens in place now, so nothing depends on it surviving.
 *
 * **A meeting's chat remembers.** Coming back to a meeting is coming back to
 * one document, and what you were asking about it is part of reading it.
 */

/** A surface that shows a scope's thread and can be unmounted like a page. */
function Surface({ scope, resetOnLeave }: { scope: string; resetOnLeave?: boolean }) {
  const [conversationId] = useActiveChat(scope, { resetOnLeave });
  return <p>{scope}: {conversationId ?? "new chat"}</p>;
}

beforeEach(() => {
  resetActiveChats();
});

describe("the workspace chat", () => {
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

    // Home to the full AI Chat page, or back again. Both are the workspace
    // chat, and neither resumes what the other was saying.
    render(<Surface scope="workspace" resetOnLeave />);

    expect(screen.getByText("workspace: new chat")).toBeInTheDocument();
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
