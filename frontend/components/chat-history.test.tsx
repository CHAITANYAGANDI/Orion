import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatConversation } from "@/lib/types";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ChatHistory } from "@/components/chat-history";

/**
 * The chat-history picker.
 *
 * The thing worth protecting is that the menu is a menu: it closes when you
 * pick something, closes when you click away, and does not swallow the page
 * behind it. A history list that stays open over the conversation it just
 * switched to hides the thing the user asked to see.
 */
function conversation(over: Partial<ChatConversation> = {}): ChatConversation {
  const iso = new Date().toISOString();
  return {
    id: "cnv_1",
    meetingId: null,
    projectId: null,
    title: "Action items last week",
    messageCount: 4,
    createdAt: iso,
    updatedAt: iso,
    ...over,
  };
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

const noop = () => Promise.resolve();

function picker(over: Partial<React.ComponentProps<typeof ChatHistory>> = {}) {
  const props = {
    conversations: [conversation()],
    activeId: null,
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onRename: vi.fn(noop),
    onDelete: vi.fn(noop),
    ...over,
  };
  render(<ChatHistory {...props} />);
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ChatHistory", () => {
  it("starts closed", () => {
    picker();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("names the open conversation on the trigger", () => {
    picker({ activeId: "cnv_1" });
    // Otherwise there is no way to tell which of five threads is on screen.
    // Read as text, not as the accessible name: the trigger is labelled
    // "Previous chat history" so it cannot collide with the New chat button
    // beside it, and the title is what it *shows*.
    const trigger = screen.getByRole("button", { name: /previous chat history/i });
    expect(trigger).toHaveTextContent(/action items last week/i);
  });

  it("says New chat when nothing is selected", () => {
    picker({ activeId: null });
    // Not "Previous chat history" any more: a picker that names the control
    // rather than the thread told you what pressing it did and never what you
    // were reading, so the panel had no title at all.
    const trigger = screen.getByRole("button", { name: /previous chat history/i });
    expect(trigger).toHaveTextContent(/new chat/i);
  });

  it("groups by recency", async () => {
    picker({
      conversations: [
        conversation({ id: "a", title: "Today thread" }),
        conversation({ id: "b", title: "Old thread", updatedAt: daysAgo(4) }),
      ],
    });

    await userEvent.click(screen.getByRole("button", { name: /previous chat history/i }));

    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Today")).toBeInTheDocument();
    expect(within(menu).getByText("Past week")).toBeInTheDocument();
  });

  it("selects a conversation and closes", async () => {
    const props = picker();

    await userEvent.click(screen.getByRole("button", { name: /previous chat history/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /action items last week/i }));

    expect(props.onSelect).toHaveBeenCalledWith("cnv_1");
    // Staying open would cover the conversation the user just asked to see.
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    picker();
    await userEvent.click(screen.getByRole("button", { name: /previous chat history/i }));

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on a click outside", async () => {
    picker();
    await userEvent.click(screen.getByRole("button", { name: /previous chat history/i }));

    await userEvent.click(document.body);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("starts a new chat", async () => {
    const props = picker();
    await userEvent.click(screen.getByRole("button", { name: /new chat/i }));
    expect(props.onNew).toHaveBeenCalled();
  });

  it("will not start a second new chat when the thread is already blank", async () => {
    // Left live it is a button that appears to do nothing, and each press
    // files another empty conversation into the history list.
    const props = picker({ atNewChat: true });

    const button = screen.getByRole("button", { name: /new chat/i });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(props.onNew).not.toHaveBeenCalled();
  });

  it("says why it is unavailable rather than just going grey", async () => {
    picker({ atNewChat: true });

    expect(screen.getByRole("button", { name: /new chat/i })).toHaveAttribute(
      "title",
      "You're already on a new chat",
    );
  });

  it("offers a new chat again once something has been said", async () => {
    const props = picker({ atNewChat: false });

    await userEvent.click(screen.getByRole("button", { name: /new chat/i }));
    expect(props.onNew).toHaveBeenCalled();
  });

  it("says so when there is no history", async () => {
    picker({ conversations: [] });
    await userEvent.click(screen.getByRole("button", { name: /previous chat history/i }));
    expect(screen.getByText(/no past conversations yet/i)).toBeInTheDocument();
  });

  it("renames a conversation", async () => {
    const props = picker();
    await userEvent.click(screen.getByRole("button", { name: /previous chat history/i }));
    await userEvent.click(screen.getByRole("button", { name: /rename action items last week/i }));

    const box = screen.getByRole("textbox", { name: /conversation name/i });
    await userEvent.clear(box);
    await userEvent.type(box, "Renewal risks{Enter}");

    expect(props.onRename).toHaveBeenCalledWith("cnv_1", "Renewal risks");
  });

  it("abandons a rename on Escape", async () => {
    const props = picker();
    await userEvent.click(screen.getByRole("button", { name: /previous chat history/i }));
    await userEvent.click(screen.getByRole("button", { name: /rename action items last week/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /conversation name/i }), "x{Escape}");

    expect(props.onRename).not.toHaveBeenCalled();
    // Escape leaves the row, not the whole menu — the user was tidying, and
    // closing the list would lose their place.
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("does not send an empty rename the server would refuse", async () => {
    const props = picker();
    await userEvent.click(screen.getByRole("button", { name: /previous chat history/i }));
    await userEvent.click(screen.getByRole("button", { name: /rename action items last week/i }));
    await userEvent.clear(screen.getByRole("textbox", { name: /conversation name/i }));
    await userEvent.click(screen.getByRole("button", { name: /save name/i }));

    expect(props.onRename).not.toHaveBeenCalled();
  });

  it("does not send a rename that changed nothing", async () => {
    const props = picker();
    await userEvent.click(screen.getByRole("button", { name: /previous chat history/i }));
    await userEvent.click(screen.getByRole("button", { name: /rename action items last week/i }));
    await userEvent.click(screen.getByRole("button", { name: /save name/i }));

    expect(props.onRename).not.toHaveBeenCalled();
  });

  it("deletes a conversation", async () => {
    const props = picker();
    await userEvent.click(screen.getByRole("button", { name: /previous chat history/i }));
    await userEvent.click(screen.getByRole("button", { name: /delete action items last week/i }));

    expect(props.onDelete).toHaveBeenCalledWith("cnv_1");
  });

  it("keeps the menu open after a delete", async () => {
    // Deleting is usually one of several; reopening between each would make
    // tidying up unusable.
    picker({
      conversations: [
        conversation({ id: "a", title: "First" }),
        conversation({ id: "b", title: "Second" }),
      ],
    });
    await userEvent.click(screen.getByRole("button", { name: /previous chat history/i }));
    await userEvent.click(screen.getByRole("button", { name: /delete first/i }));

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});


/**
 * Getting more room.
 *
 * Two surfaces, two answers, one icon. The home rail has a full page to open —
 * /ask, the same conversation at a bigger size — so its control navigates. A
 * meeting's chat has no such page and inventing one would put a second copy of
 * the conversation at a second URL, with the transcript it is about left
 * behind. So that one grows in place instead.
 */
describe("the expand control", () => {
  it("is absent where there is nowhere bigger to go", () => {
    picker();

    // The full AI Chat page passes neither. A button that reloads the page you
    // are already on is a dead control.
    expect(screen.queryByRole("link", { name: /full chat/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /expand/i })).not.toBeInTheDocument();
  });

  it("navigates when the surface has a bigger page", () => {
    picker({ expandHref: "/ask", expandLabel: "Open the full chat" });

    expect(screen.getByRole("link", { name: "Open the full chat" })).toHaveAttribute(
      "href",
      "/ask",
    );
  });

  it("expands in place when it does not", async () => {
    const onExpand = vi.fn();
    picker({ onExpand });

    await userEvent.click(screen.getByRole("button", { name: "Expand the chat" }));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("offers the way back once it is expanded", async () => {
    const onExpand = vi.fn();
    picker({ onExpand, expanded: true });

    // Named for what pressing it does. "Expand the chat" on a chat that is
    // already expanded is a control lying about its own effect, and it is the
    // only way back to the transcript underneath.
    const button = screen.getByRole("button", { name: "Shrink the chat back to the panel" });
    expect(button).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(button);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("does not offer both at once", () => {
    picker({ expandHref: "/ask", expandLabel: "Open the full chat", onExpand: vi.fn() });

    // One control. Two, side by side, would be two icons that both mean "more
    // room" and disagree about where.
    expect(screen.getByRole("link", { name: "Open the full chat" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /expand the chat/i })).not.toBeInTheDocument();
  });
});
