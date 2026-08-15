import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatMessage } from "@/lib/types";

// vi.mock is hoisted above the file's own consts, so the spy has to be created
// inside vi.hoisted to exist by the time the factory runs.
const { errorToast } = vi.hoisted(() => ({ errorToast: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: errorToast, success: vi.fn() } }));

import { ChatMessageBubble } from "@/components/chat-message";

/**
 * Copy and delete on a chat turn.
 *
 * The label on copy is worth pinning: it is the only thing distinguishing
 * "copy what I asked" from "copy what it said", both buttons look identical,
 * and getting it backwards is invisible until somebody pastes the wrong half
 * into a ticket.
 */
function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "msg_1",
    conversationId: "cnv_1",
    role: "assistant",
    content: "The renewal was signed on the 9th.",
    citations: [],
    createdAt: "2026-08-14T09:00:00Z",
    ...over,
  };
}

const writeText = vi.fn(() => Promise.resolve());

beforeEach(() => {
  writeText.mockClear();
  writeText.mockImplementation(() => Promise.resolve());
  errorToast.mockClear();
  Object.assign(navigator, { clipboard: { writeText } });
});

describe("ChatMessageBubble", () => {
  it("shows the message", () => {
    render(<ChatMessageBubble message={message()} />);
    expect(screen.getByText("The renewal was signed on the 9th.")).toBeInTheDocument();
  });

  it("copies an answer", async () => {
    render(<ChatMessageBubble message={message()} />);

    await userEvent.click(screen.getByRole("button", { name: "Copy answer" }));

    expect(writeText).toHaveBeenCalledWith("The renewal was signed on the 9th.");
  });

  it("calls the user's turn a prompt", async () => {
    render(<ChatMessageBubble message={message({ role: "user", content: "When did we sign?" })} />);

    // Not "Copy answer" — the two buttons are identical to look at, and the
    // label is the only thing that says which half is being copied.
    await userEvent.click(screen.getByRole("button", { name: "Copy prompt" }));

    expect(writeText).toHaveBeenCalledWith("When did we sign?");
  });

  it("copies the text only, not the citations", async () => {
    render(
      <ChatMessageBubble message={message()}>
        <span>12:34</span>
      </ChatMessageBubble>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Copy answer" }));

    // Dragging to select a bubble picks up the citation chips too, which is
    // the reason this button exists rather than trusting selection.
    expect(writeText).toHaveBeenCalledWith("The renewal was signed on the 9th.");
  });

  it("confirms the copy", async () => {
    render(<ChatMessageBubble message={message()} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    // Without feedback, a click that copies silently reads as a dead button.
    expect(await screen.findByRole("button", { name: "Copy answer" })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledOnce();
  });

  it("says so when the browser blocks the clipboard", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    render(<ChatMessageBubble message={message()} />);

    await userEvent.click(screen.getByRole("button", { name: "Copy answer" }));

    expect(errorToast).toHaveBeenCalled();
  });

  it("renders its citations", () => {
    render(
      <ChatMessageBubble message={message()}>
        <span data-testid="citations">sources</span>
      </ChatMessageBubble>,
    );
    expect(screen.getByTestId("citations")).toBeInTheDocument();
  });

  it("deletes by message id", async () => {
    const onDelete = vi.fn(() => Promise.resolve());
    render(<ChatMessageBubble message={message()} onDelete={onDelete} />);

    await userEvent.click(screen.getByRole("button", { name: /delete this exchange/i }));

    expect(onDelete).toHaveBeenCalledWith("msg_1");
  });

  it("says it deletes the exchange, not the message", () => {
    const onDelete = vi.fn(() => Promise.resolve());
    render(<ChatMessageBubble message={message()} onDelete={onDelete} />);

    // The server removes the question with its answer. A button that promised
    // to delete only this turn would be lying about what it does.
    expect(screen.getByRole("button", { name: /delete this exchange/i }))
      .toHaveAttribute("title", "Delete this question and its answer");
  });

  it("offers no delete when the chat does not support it", () => {
    render(<ChatMessageBubble message={message()} />);
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
  });

  it("cannot be deleted twice while one is in flight", async () => {
    const onDelete = vi.fn(() => Promise.resolve());
    render(<ChatMessageBubble message={message()} onDelete={onDelete} deleting />);

    await userEvent.click(screen.getByRole("button", { name: /delete this exchange/i }));

    expect(onDelete).not.toHaveBeenCalled();
  });

  it("reports a failed delete rather than looking like it worked", async () => {
    const onDelete = vi.fn(() => Promise.reject(new Error("nope")));
    render(<ChatMessageBubble message={message()} onDelete={onDelete} />);

    await userEvent.click(screen.getByRole("button", { name: /delete this exchange/i }));

    expect(errorToast).toHaveBeenCalled();
  });
});
