import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SelectionMenu, isInsideSelectionMenu } from "@/components/selection-menu";

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
      "Ask Reverie",
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

  it("is recognisable to the page's dismiss handler", () => {
    // How the transcript tells "clicked an action" from "clicked away". It
    // cannot be told by stopping the event: React's listeners sit on the same
    // node as the page's, so stopPropagation never gets there first. Dismissing
    // on a press inside unmounts the button before mouseup, and no click
    // follows -- the menu looks open and every action does nothing.
    render(<SelectionMenu anchor={anchor} onAction={vi.fn()} />);

    expect(isInsideSelectionMenu(screen.getByText("Highlight"))).toBe(true);
    expect(isInsideSelectionMenu(screen.getByRole("menu"))).toBe(true);
  });

  it("does not claim presses outside it", () => {
    render(
      <>
        <p>Elsewhere</p>
        <SelectionMenu anchor={anchor} onAction={vi.fn()} />
      </>,
    );

    expect(isInsideSelectionMenu(screen.getByText("Elsewhere"))).toBe(false);
    expect(isInsideSelectionMenu(document.body)).toBe(false);
    expect(isInsideSelectionMenu(null)).toBe(false);
  });

  it("survives its own mousedown when the page dismisses on document", () => {
    // The transcript, in miniature: the menu is held open by state, and a
    // document-level mousedown closes it. This is the arrangement that shipped
    // broken -- the menu unmounted under the pointer, so mouseup landed on
    // nothing and the browser never dispatched a click on the button.
    function Harness({ onAction }: { onAction: (a: string) => void }) {
      const [open, setOpen] = React.useState(true);
      React.useEffect(() => {
        function onDown(e: MouseEvent) {
          if (isInsideSelectionMenu(e.target)) return;
          setOpen(false);
        }
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
      }, []);
      return <SelectionMenu anchor={open ? anchor : null} onAction={onAction} />;
    }

    const onAction = vi.fn();
    render(<Harness onAction={onAction} />);

    fireEvent.mouseDown(screen.getByText("Wrong speaker"));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Wrong speaker"));
    expect(onAction).toHaveBeenCalledWith("reassign");
  });

  it("reads a press that landed on text inside it", () => {
    // mousedown reports an element, but a selection endpoint or a synthetic
    // event can report the text node itself, and a text node has no `closest`.
    render(<SelectionMenu anchor={anchor} onAction={vi.fn()} />);

    // The icon is the first child; the label text follows it.
    const text = screen.getByText("Copy").lastChild;
    expect(text?.nodeType).toBe(Node.TEXT_NODE);
    expect(isInsideSelectionMenu(text)).toBe(true);
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
