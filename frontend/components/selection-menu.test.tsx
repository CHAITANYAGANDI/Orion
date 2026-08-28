import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SelectionMenu } from "@/components/selection-menu";

/**
 * The menu over a transcript selection.
 *
 * Two of these tests are about a bug that is invisible in review and total in
 * practice: the menu is opened by a selection, and a selection is destroyed by
 * the next mousedown. If the menu does not suppress its own mousedown, every
 * item is dead — it closes the menu and clears the very selection the action
 * was about to read. Nothing throws; the buttons just do nothing.
 *
 * The rest is placement. A menu that renders below a selection near the bottom
 * of the window puts its last items off-screen, which on a long transcript is
 * most of the window's height.
 */

const anchor = { top: 300, left: 100, bottom: 320 };

beforeEach(() => {
  // jsdom defaults to 768×1024; pinned so the flip assertions are about the
  // component's arithmetic rather than about the harness.
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
});

describe("SelectionMenu", () => {
  it("renders nothing without a selection", () => {
    const { container } = render(<SelectionMenu anchor={null} onAction={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers every action on the transcript selection menu", () => {
    render(<SelectionMenu anchor={anchor} onAction={vi.fn()} />);
    for (const label of [
      "Highlight",
      "Copy",
      "Add note",
      "Ask Orion",
      "Summarize",
      "Create action item",
      "Copy link to moment",
    ]) {
      expect(screen.getByRole("menuitem", { name: label })).toBeInTheDocument();
    }
  });

  it("reports which action was chosen", async () => {
    const onAction = vi.fn();
    render(<SelectionMenu anchor={anchor} onAction={onAction} />);

    await userEvent.click(screen.getByRole("menuitem", { name: "Highlight" }));

    expect(onAction).toHaveBeenCalledWith("highlight");
  });

  it("suppresses its own mousedown", () => {
    // The whole menu is useless without this: mousedown moves focus, moving
    // focus drops the selection, and the action then has nothing to act on.
    render(<SelectionMenu anchor={anchor} onAction={vi.fn()} />);
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });

    screen.getByRole("menu").dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("keeps its mousedown away from the page's dismiss handler", () => {
    // The transcript closes the menu on any mousedown outside it. Without
    // stopPropagation that fires for clicks *inside* it too, closing the menu
    // before the click completes.
    const onDocument = vi.fn();
    document.addEventListener("mousedown", onDocument);
    render(<SelectionMenu anchor={anchor} onAction={vi.fn()} />);

    screen
      .getByRole("menu")
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    expect(onDocument).not.toHaveBeenCalled();
    document.removeEventListener("mousedown", onDocument);
  });

  it("sits below a selection with room under it", () => {
    render(<SelectionMenu anchor={anchor} onAction={vi.fn()} />);
    expect(screen.getByRole("menu")).toHaveStyle({ top: "328px" });
  });

  it("flips above a selection near the bottom of the window", () => {
    // Otherwise the actions run off the bottom of a viewport the user cannot
    // scroll without losing the selection.
    render(
      <SelectionMenu anchor={{ top: 700, left: 100, bottom: 740 }} onAction={vi.fn()} />,
    );
    const top = Number.parseInt(screen.getByRole("menu").style.top, 10);
    expect(top).toBeLessThan(700);
  });

  it("stays inside the right edge", () => {
    render(
      <SelectionMenu anchor={{ top: 300, left: 1190, bottom: 320 }} onAction={vi.fn()} />,
    );
    const left = Number.parseInt(screen.getByRole("menu").style.left, 10);
    expect(left).toBeLessThanOrEqual(1200 - 210);
  });

  it("cannot be clicked twice while a mark is saving", async () => {
    const onAction = vi.fn();
    render(<SelectionMenu anchor={anchor} onAction={onAction} busy />);

    await userEvent.click(screen.getByRole("menuitem", { name: "Highlight" }));

    expect(onAction).not.toHaveBeenCalled();
  });
});
