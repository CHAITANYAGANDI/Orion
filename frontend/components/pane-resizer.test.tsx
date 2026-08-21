import { describe, it, expect } from "vitest";
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PaneResizer } from "@/components/pane-resizer";

/**
 * The divider between two panes.
 *
 * What is asserted is the one thing about a splitter that is easy to get
 * backwards and impossible to notice in review: which way it moves. The handle
 * on the left of the window and the handle on the right respond to the same
 * key, and if both are wired to "grow", Right shrinks the page on one side of
 * the screen and grows it on the other.
 *
 * The keyboard path is not a courtesy here — a pane that can only be resized by
 * dragging is a pane some people cannot resize at all — so it is tested as the
 * primary interface rather than as an afterthought to the drag.
 */

const BOUNDS = { min: 200, max: 400 };

function Harness({ side, initial = 256 }: { side: "left" | "right"; initial?: number }) {
  const [width, setWidth] = React.useState(initial);
  return (
    <>
      <PaneResizer
        side={side}
        width={width}
        min={BOUNDS.min}
        max={BOUNDS.max}
        onWidth={setWidth}
        onReset={() => setWidth(256)}
        label="Resize the sidebar"
      />
      <output>{width}</output>
    </>
  );
}

function handle() {
  return screen.getByRole("separator", { name: "Resize the sidebar" });
}

function width() {
  return Number(screen.getByRole("status").textContent);
}

/**
 * A pointer event, built by hand.
 *
 * jsdom implements no Pointer Events API — there is no `PointerEvent`
 * constructor — so `fireEvent.pointerMove` falls back to a bare `Event` with no
 * `clientX` and no `pointerId` on it, and every drag below would be a drag of
 * `undefined` pixels. A `MouseEvent` carries the coordinates the real thing
 * would and React dispatches on the type string, so this is the browser's event
 * in everything the component reads off it.
 *
 * Deliberately not a global `PointerEvent` shim in the setup file: several
 * libraries branch on whether that constructor exists, and defining one would
 * change how a thousand unrelated tests behave to make eleven of them tidier.
 */
function pointer(
  type: "pointerDown" | "pointerMove" | "pointerUp",
  init: { pointerId: number; clientX?: number },
) {
  const event = new MouseEvent(type.toLowerCase(), {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: init.clientX ?? 0,
  });
  Object.assign(event, { pointerId: init.pointerId, pointerType: "mouse" });
  fireEvent(handle(), event);
}

describe("PaneResizer", () => {
  it("reports where it is and how far it goes", () => {
    render(<Harness side="left" />);

    // A splitter with no value is a splitter a screen reader announces as an
    // anonymous separator, with no way to tell that it moved.
    expect(handle()).toHaveAttribute("aria-valuenow", "256");
    expect(handle()).toHaveAttribute("aria-valuemin", "200");
    expect(handle()).toHaveAttribute("aria-valuemax", "400");
    expect(handle()).toHaveAttribute("aria-orientation", "vertical");
  });

  it("can be reached by keyboard", async () => {
    render(<Harness side="left" />);

    await userEvent.tab();
    expect(handle()).toHaveFocus();
  });

  it("moves the divider, not the pane", async () => {
    render(<Harness side="left" />);
    handle().focus();

    // Right means the divider goes right, which on the left-hand pane is wider.
    await userEvent.keyboard("{ArrowRight}");
    expect(width()).toBe(272);
    await userEvent.keyboard("{ArrowLeft}");
    expect(width()).toBe(256);
  });

  it("moves the same key the same direction on the other side", async () => {
    render(<Harness side="right" />);
    handle().focus();

    // Same key, same physical direction, opposite effect on the width — which
    // is the point. A right-hand pane grows when its divider goes *left*.
    await userEvent.keyboard("{ArrowRight}");
    expect(width()).toBe(240);
    await userEvent.keyboard("{ArrowLeft}");
    expect(width()).toBe(256);
  });

  it("moves further with Shift held", async () => {
    render(<Harness side="left" />);
    handle().focus();

    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(width()).toBe(320);
  });

  it("goes to the ends with Home and End", async () => {
    render(<Harness side="left" />);
    handle().focus();

    await userEvent.keyboard("{End}");
    expect(width()).toBe(400);
    await userEvent.keyboard("{Home}");
    expect(width()).toBe(200);
  });

  it("stops at the bounds rather than running past them", async () => {
    render(<Harness side="left" initial={392} />);
    handle().focus();

    await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
    expect(width()).toBe(400);
  });

  it("restores the default on a double-click", async () => {
    render(<Harness side="left" initial={390} />);

    // The way back from having dragged something to a width that turned out to
    // be unusable, without having to guess at what it was before.
    await userEvent.dblClick(handle());
    expect(width()).toBe(256);
  });

  it("follows a drag by how far the pointer moved", () => {
    render(<Harness side="left" />);

    pointer("pointerDown", { pointerId: 1, clientX: 256 });
    pointer("pointerMove", { pointerId: 1, clientX: 300 });
    expect(width()).toBe(300);

    // Still tracking after the pointer leaves the handle — the eight pixels it
    // occupies are the first eight of a drag, not all of it.
    pointer("pointerMove", { pointerId: 1, clientX: 340 });
    expect(width()).toBe(340);

    pointer("pointerUp", { pointerId: 1 });
    pointer("pointerMove", { pointerId: 1, clientX: 200 });
    expect(width()).toBe(340);
  });

  it("ignores a pointer that is not the one that started the drag", () => {
    render(<Harness side="left" />);

    pointer("pointerDown", { pointerId: 1, clientX: 256 });
    // A second finger landing on a tablet, or a stylus while a mouse is down.
    pointer("pointerMove", { pointerId: 2, clientX: 380 });
    expect(width()).toBe(256);
  });

  it("does nothing until a drag has started", () => {
    render(<Harness side="left" />);

    // Every pointer that crosses the divider on its way somewhere else.
    pointer("pointerMove", { pointerId: 1, clientX: 390 });
    expect(width()).toBe(256);
  });
});
