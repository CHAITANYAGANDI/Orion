import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TurnActions, TurnReactions, REACTIONS } from "@/components/turn-actions";

/**
 * The toolbar over a turn.
 *
 * Two things are worth holding still here. The first is that everything on it
 * is a *toggle* — reacting and bookmarking both undo by repeating themselves,
 * and a toolbar that only ever adds turns a one-click gesture into a trip to
 * another panel. The second is that it must not swallow clicks while it is
 * invisible: it floats over the row carrying the speaker's name and timestamp,
 * so an invisible bar with pointer events is a timestamp that stops working
 * for no visible reason.
 */
function toolbar(over: Partial<React.ComponentProps<typeof TurnActions>> = {}) {
  const props = {
    context: "Priya at 12:04",
    reactions: [] as string[],
    bookmarked: false,
    onReact: vi.fn(),
    onBookmark: vi.fn(),
    onComment: vi.fn(),
    onCopy: vi.fn(),
    onShare: vi.fn(),
    ...over,
  };
  render(<TurnActions {...props} />);
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TurnActions", () => {
  it("names the turn once, on the group, rather than in every button", () => {
    toolbar();
    expect(screen.getByRole("group", { name: "Actions for Priya at 12:04" })).toBeInTheDocument();
  });

  it("offers the five gestures that take a whole turn", () => {
    toolbar();
    expect(screen.getByLabelText("More reactions")).toBeInTheDocument();
    expect(screen.getByLabelText("Add a note here")).toBeInTheDocument();
    expect(screen.getByLabelText("Bookmark this moment")).toBeInTheDocument();
    expect(screen.getByLabelText("Copy with attribution")).toBeInTheDocument();
    expect(screen.getByLabelText("Copy link to this moment")).toBeInTheDocument();
  });

  it("keeps the commonest reaction off the menu", async () => {
    const user = userEvent.setup();
    const props = toolbar();
    await user.click(screen.getByLabelText("React 👍"));
    expect(props.onReact).toHaveBeenCalledWith("👍");
  });

  it("reads as pressed, and undoes, once a reaction is on the turn", async () => {
    const user = userEvent.setup();
    const props = toolbar({ reactions: ["👍"] });
    const quick = screen.getByLabelText("Remove 👍");
    expect(quick).toHaveAttribute("aria-pressed", "true");
    await user.click(quick);
    // The same call as adding it. Which way it goes is the caller's decision,
    // because only the caller knows what is already saved.
    expect(props.onReact).toHaveBeenCalledWith("👍");
  });

  it("opens a palette rather than an emoji keyboard", async () => {
    const user = userEvent.setup();
    toolbar();
    await user.click(screen.getByLabelText("More reactions"));
    for (const { emoji } of REACTIONS) {
      expect(screen.getByText(emoji)).toBeInTheDocument();
    }
  });

  it("says who can see a reaction, where the reaction is chosen", async () => {
    const user = userEvent.setup();
    toolbar();
    await user.click(screen.getByLabelText("More reactions"));
    // Reverie has one account per workspace. Somebody reaching for a thumbs-up
    // to answer a colleague is entitled to find out before they rely on it.
    expect(screen.getByText(/never appear in a shared link/)).toBeInTheDocument();
  });

  it("closes the palette on a pick, so a second click is a second reaction", async () => {
    const user = userEvent.setup();
    const props = toolbar();
    await user.click(screen.getByLabelText("More reactions"));
    await user.click(screen.getByText("🔥"));
    expect(props.onReact).toHaveBeenCalledWith("🔥");
    expect(screen.queryByText("🎉")).not.toBeInTheDocument();
  });

  it("toggles the bookmark, and says which way it is going", async () => {
    const user = userEvent.setup();
    const props = toolbar({ bookmarked: true });
    await user.click(screen.getByLabelText("Remove bookmark"));
    expect(props.onBookmark).toHaveBeenCalled();
  });

  it("lets nothing through while it is hidden", () => {
    toolbar();
    const bar = screen.getByRole("group");
    // The bar overlaps the speaker row. Invisible and still clickable would
    // make the timestamp beside the name unreachable.
    expect(bar?.className).toContain("pointer-events-none");
    expect(bar?.className).toContain("group-hover:pointer-events-auto");
  });

  it("stays out of the way while a mark is saving", () => {
    toolbar({ busy: true });
    expect(screen.getByLabelText("React 👍")).toBeDisabled();
    expect(screen.getByLabelText("Add a note here")).toBeDisabled();
    // Copy and the link touch nothing on the server, so there is nothing for
    // them to race.
    expect(screen.getByLabelText("Copy with attribution")).not.toBeDisabled();
  });
});

describe("TurnReactions", () => {
  it("renders nothing when there is nothing to render", () => {
    const { container } = render(<TurnReactions reactions={[]} onToggle={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("removes on click, which is the whole undo path", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<TurnReactions reactions={["👍", "🔥"]} onToggle={onToggle} />);
    await user.click(screen.getByLabelText("Remove 🔥 reaction"));
    expect(onToggle).toHaveBeenCalledWith("🔥");
  });
});
