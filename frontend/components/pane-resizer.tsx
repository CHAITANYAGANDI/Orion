"use client";

/**
 * The divider between two panes, which you can drag.
 *
 * ## Why the caller positions it
 *
 * A handle wide enough to hit is about eight pixels, and eight pixels of layout
 * between the folder rail and the page would be a visible gutter that is there
 * for the mouse's benefit and nobody else's. So it is taken out of flow and
 * laid over the border it moves — but *how* differs by pane, and neither way is
 * a detail this component can guess. The left rail scrolls its own contents,
 * and `overflow-y: auto` forces `overflow-x` to compute to `auto` as well, so a
 * child hanging over that edge is clipped and given a scrollbar for the
 * trouble; it takes a `fixed` handle tracking the rail's width. The right pane
 * scrolls nothing itself and takes an ordinary `absolute` one.
 *
 * ## Why it is focusable
 *
 * Because a pane you can only resize by dragging is a pane some people cannot
 * resize. This is the ARIA window-splitter pattern: `role="separator"` with a
 * value and bounds, arrow keys to move it, Home and End for the extremes. The
 * arrow keys move the *divider*, not the pane — Right always means "this
 * divider goes right", which grows a left-hand pane and shrinks a right-hand
 * one. Mapping both to "grow" would mean the same key did opposite things on
 * the two sides of one screen.
 *
 * Double-click restores the default. It is the standard escape from having
 * dragged something to a width that turned out to be unusable, and it is
 * quicker than dragging back to a value you were not measuring.
 */

import * as React from "react";
import { clampWidth } from "@/lib/pane-size";
import { cn } from "@/lib/utils";

/** How far one arrow key moves the divider, and one arrow key with Shift. */
const STEP = 16;
const BIG_STEP = 64;

export function PaneResizer({
  side,
  width,
  min,
  max,
  onWidth,
  onReset,
  label,
  className,
}: {
  /** Which side of the window the pane being sized is on. */
  side: "left" | "right";
  width: number;
  min: number;
  max: number;
  onWidth: (px: number) => void;
  /** Double-click. Omitted means double-click does nothing. */
  onReset?: () => void;
  /** Names the pane, not the handle: "Resize the sidebar". */
  label: string;
  /** Where it sits. Required in practice — see the note above. */
  className?: string;
}) {
  const [dragging, setDragging] = React.useState(false);
  // Where the pointer went down and how wide the pane was then. Moving by a
  // delta from that, rather than by the pointer's absolute position, keeps the
  // divider under the cursor wherever on the handle the drag started — and
  // stays right if the page scrolls or a scrollbar appears mid-drag.
  const from = React.useRef<{ pointerId: number; x: number; width: number } | null>(null);

  // The cursor belongs to the whole window while a drag is running: the pointer
  // will spend most of the drag over the transcript, not over a six-pixel
  // handle, and a text caret there says the drag has ended when it has not.
  // `select-none` stops the drag from painting the page blue on the way past.
  React.useEffect(() => {
    if (!dragging) return;
    const { classList } = document.body;
    classList.add("cursor-col-resize", "select-none");
    return () => classList.remove("cursor-col-resize", "select-none");
  }, [dragging]);

  function grow(by: number) {
    onWidth(clampWidth(width + (side === "left" ? by : -by), { min, max }));
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Stops the drag from starting a text selection in whichever pane the
    // pointer crosses next.
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    from.current = { pointerId: e.pointerId, x: e.clientX, width };
    setDragging(true);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const start = from.current;
    if (!start || start.pointerId !== e.pointerId) return;
    const delta = e.clientX - start.x;
    onWidth(clampWidth(start.width + (side === "left" ? delta : -delta), { min, max }));
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (from.current?.pointerId !== e.pointerId) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    from.current = null;
    setDragging(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? BIG_STEP : STEP;
    switch (e.key) {
      case "ArrowLeft":
        grow(-step);
        break;
      case "ArrowRight":
        grow(step);
        break;
      case "Home":
        onWidth(side === "left" ? min : max);
        break;
      case "End":
        onWidth(side === "left" ? max : min);
        break;
      default:
        return;
    }
    // Only once a key has been handled: Tab and Escape have to keep working,
    // and arrow keys scroll the page everywhere else.
    e.preventDefault();
  }

  return (
    <div
      role="separator"
      // The handle is a vertical line. Left and Right move it, which is what
      // this tells a screen reader to say.
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className={cn(
        // Hidden below `lg`, where neither pane is a column: the left one is a
        // drawer over the page and the right one is a block beneath it. There
        // is no divider to move.
        "z-30 hidden w-2 cursor-col-resize touch-none lg:block",
        // Invisible until it matters. The border it sits on is already the
        // line between the two panes; a second one drawn on top would be a
        // permanent seam. It lights up under the pointer and while dragging,
        // and takes a focus ring like anything else that can be tabbed to.
        "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2",
        "after:bg-transparent after:transition-colors hover:after:bg-primary/60",
        "focus-visible:outline-none focus-visible:after:bg-primary focus-visible:after:w-0.5",
        dragging && "after:bg-primary after:w-0.5",
        className,
      )}
    />
  );
}
