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
 *
 * Delete is pinned to the question for a related reason. It removes the pair,
 * and under an answer that reads as "delete this answer" — so people pressed
 * it to clear a bad reply and lost the question they had typed with it.
 */

/** The user's turn. Everything about delete is asserted on this one. */
function prompt(over: Partial<ChatMessage> = {}): ChatMessage {
  return message({ id: "msg_1", role: "user", content: "When was it signed?", ...over });
}
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
    render(<ChatMessageBubble message={prompt()} onDelete={onDelete} />);

    await userEvent.click(screen.getByRole("button", { name: /delete this exchange/i }));

    expect(onDelete).toHaveBeenCalledWith("msg_1");
  });

  it("says it deletes the exchange, not the message", () => {
    const onDelete = vi.fn(() => Promise.resolve());
    render(<ChatMessageBubble message={prompt()} onDelete={onDelete} />);

    // The server removes the question with its answer. A button that promised
    // to delete only this turn would be lying about what it does.
    expect(screen.getByRole("button", { name: /delete this exchange/i }))
      .toHaveAttribute("title", "Delete this question and its answer");
  });

  it("puts no bin under an answer, even where the chat supports deleting", () => {
    // The bug this replaces. A bin under a reply reads as "delete this reply",
    // which the API cannot do and nobody meant: it took the question with it.
    render(<ChatMessageBubble message={message()} onDelete={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
    // Copy stays. Reading an answer and taking it somewhere else is the whole
    // point of the surface.
    expect(screen.getByRole("button", { name: "Copy answer" })).toBeInTheDocument();
  });

  it("offers no delete when the chat does not support it", () => {
    render(<ChatMessageBubble message={prompt()} />);
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
  });

  it("cannot be deleted twice while one is in flight", async () => {
    const onDelete = vi.fn(() => Promise.resolve());
    render(<ChatMessageBubble message={prompt()} onDelete={onDelete} deleting />);

    await userEvent.click(screen.getByRole("button", { name: /delete this exchange/i }));

    expect(onDelete).not.toHaveBeenCalled();
  });

  it("reports a failed delete rather than looking like it worked", async () => {
    const onDelete = vi.fn(() => Promise.reject(new Error("nope")));
    render(<ChatMessageBubble message={prompt()} onDelete={onDelete} />);

    await userEvent.click(screen.getByRole("button", { name: /delete this exchange/i }));

    expect(errorToast).toHaveBeenCalled();
  });
});

/**
 * The order of loudness.
 *
 * <p>A question is the reader's own words; an answer is what they came for. The
 * question used to be a filled pill in the primary colour, and under the V2
 * palette `--primary` is ink — near-white — which made the loudest thing on the
 * screen the sentence somebody had just typed themselves.
 */
describe("how the two sides are set", () => {
  it("sets an answer in the reading face", () => {
    // The same face as a transcript and a brief, because it is the same act.
    const { container } = render(<ChatMessageBubble message={message()} />);

    expect(container.querySelector(".v2-read")).toBeInTheDocument();
  });

  it("leaves a question in the interface face", () => {
    // It is not prose anybody is settling in to read, and a serif on both sides
    // removes the one distinction that is free.
    const { container } = render(<ChatMessageBubble message={prompt()} />);

    expect(container.querySelector(".v2-read")).not.toBeInTheDocument();
  });

  it("does not fill the question with the primary colour", () => {
    // `bg-primary` is ink now. A near-white slab beside the answer is the wrong
    // thing to be the brightest object on the page.
    const { container } = render(<ChatMessageBubble message={prompt()} />);

    expect(container.innerHTML).not.toContain("bg-primary");
  });

  it("keeps the question a bubble, capped and on the right", () => {
    // Quieter, not gone. The alignment and the tint are what say whose turn
    // this is, and both survive.
    const { container } = render(<ChatMessageBubble message={prompt()} />);

    expect(container.innerHTML).toContain("rounded-2xl");
    expect(container.innerHTML).toContain("max-w-[85%]");
    expect(container.innerHTML).toContain("justify-end");
  });
});
