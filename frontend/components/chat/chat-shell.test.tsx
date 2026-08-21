import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatDock, ChatRail } from "@/components/chat/chat-shell";
import type { ChatPrompt } from "@/lib/chat-prompts";

/**
 * The layout every Recallix chat shares.
 *
 * Three surfaces draw a conversation — the home rail, the meeting rail and the
 * full AI Chat page — and they had drifted into three different shapes. What is
 * asserted here is the shape, not the data: the scopes stay separate on purpose
 * and neither of them is visible from this file.
 */

const PROMPTS: ChatPrompt[] = [
  { label: "What hasn't been completed?", prompt: "What hasn't been completed?" },
  { label: "Find every mention of…", prompt: "Find every mention of " },
];

function dock(over: Partial<React.ComponentProps<typeof ChatDock>> = {}) {
  const props = {
    prompts: PROMPTS,
    showPrompts: true,
    onSend: vi.fn(),
    onCompose: vi.fn(),
    grounding: "Answers come from your own meetings, and go nowhere else.",
    children: <textarea aria-label="Ask a question" />,
    ...over,
  };
  render(<ChatDock {...props} />);
  return props;
}

describe("ChatDock", () => {
  it("puts the starter prompts above the box they fill in", () => {
    dock();

    // Order matters and is the whole point: these used to sit in the middle of
    // the empty thread, where the first answer was about to appear.
    const region = screen.getByLabelText("Ask a question").parentElement!;
    const text = region.textContent ?? "";
    expect(text.indexOf("Suggestions")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Suggestions")).toBeLessThan(text.indexOf("Answers come from"));
  });

  it("sends a complete prompt and composes an unfinished one", async () => {
    const props = dock();

    await userEvent.click(screen.getByRole("button", { name: /hasn't been completed/i }));
    expect(props.onSend).toHaveBeenCalledWith("What hasn't been completed?");

    // A prompt ending in a space is an opening, not a question. Sending it as
    // it stands would ask the model to search for nothing.
    await userEvent.click(screen.getByRole("button", { name: /find every mention/i }));
    expect(props.onCompose).toHaveBeenCalledWith("Find every mention of ");
  });

  it("drops the prompts once the conversation has started", () => {
    dock({ showPrompts: false });

    // A permanent row competes with the thread, and keeps offering "summarize
    // this meeting" to somebody who already has the summary open.
    expect(screen.queryByText("Suggestions")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /hasn't been completed/i })).not.toBeInTheDocument();
  });

  it("keeps the grounding notice whether or not there are prompts", () => {
    dock({ showPrompts: false });

    // The chat reads transcripts. One line saying where an answer came from is
    // the only way a reader knows nothing left.
    expect(screen.getByText(/go nowhere else/i)).toBeInTheDocument();
  });

  it("does not offer a prompt while a question is in flight", () => {
    dock({ busy: true });

    expect(screen.getByRole("button", { name: /hasn't been completed/i })).toBeDisabled();
  });
});

describe("ChatRail", () => {
  it("scrolls the thread and nothing else", () => {
    render(
      <ChatRail header={<p>header</p>} dock={<p>dock</p>}>
        <p>a message</p>
      </ChatRail>,
    );

    const thread = screen.getByText("a message").parentElement!;
    // `min-h-0` is what makes the middle region scroll instead of growing the
    // column and pushing the composer off the bottom of the window. It is one
    // class and losing it is invisible until a conversation gets long.
    expect(thread.className).toContain("min-h-0");
    expect(thread.className).toContain("overflow-y-auto");
  });

  it("keeps the header and the dock out of the scrolling region", () => {
    render(
      <ChatRail header={<p>header</p>} dock={<p>dock</p>}>
        <p>a message</p>
      </ChatRail>,
    );

    const thread = screen.getByText("a message").parentElement!;
    expect(thread).not.toHaveTextContent("header");
    expect(thread).not.toHaveTextContent("dock");
  });
});
