import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatSuggestions } from "@/components/chat-suggestions";

/**
 * The starter chips.
 *
 * One behaviour here is easy to get backwards and expensive when it is: a chip
 * whose prompt is an opening — "Find every discussion about " — must land in
 * the input for the user to finish, not be sent. Sending it asks the model to
 * search for nothing, and the model obliges with a confident answer about
 * everything.
 */
const complete = { label: "What did we decide?", prompt: "What did we decide in this meeting?" };
const opening = { label: "Find every mention of…", prompt: "Find every discussion about " };

function setup(prompts = [complete, opening], disabled = false) {
  const onSend = vi.fn();
  const onCompose = vi.fn();
  render(
    <ChatSuggestions prompts={prompts} disabled={disabled} onSend={onSend} onCompose={onCompose} />,
  );
  return { onSend, onCompose, user: userEvent.setup() };
}

describe("ChatSuggestions", () => {
  it("renders nothing when there are no prompts", () => {
    const { container } = render(
      <ChatSuggestions prompts={[]} onSend={vi.fn()} onCompose={vi.fn()} />,
    );
    // Not an empty "Try one of these" heading with no chips under it.
    expect(container).toBeEmptyDOMElement();
  });

  it("sends a complete question", async () => {
    const { onSend, onCompose, user } = setup();
    await user.click(screen.getByRole("button", { name: /What did we decide/ }));
    expect(onSend).toHaveBeenCalledWith(complete.prompt);
    expect(onCompose).not.toHaveBeenCalled();
  });

  it("composes an unfinished one instead of sending it", async () => {
    const { onSend, onCompose, user } = setup();
    await user.click(screen.getByRole("button", { name: /Find every mention/ }));
    expect(onCompose).toHaveBeenCalledWith(opening.prompt);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows an ellipsis on the ones that need finishing", async () => {
    setup();
    // Asserted on the rendered text rather than the accessible name: the
    // ellipsis is aria-hidden, deliberately, because a screen reader announcing
    // "dot dot dot" is noise where the visual cue is the whole point.
    expect(screen.getByRole("button", { name: /Find every mention/ })).toHaveTextContent("…");
    expect(screen.getByRole("button", { name: /What did we decide/ })).not.toHaveTextContent("…");
  });

  it("does nothing while the chat is busy", async () => {
    const { onSend, onCompose, user } = setup([complete, opening], true);
    await user.click(screen.getByRole("button", { name: /What did we decide/ }));
    // Clicking a second question mid-answer would interleave two requests.
    expect(onSend).not.toHaveBeenCalled();
    expect(onCompose).not.toHaveBeenCalled();
  });
});
