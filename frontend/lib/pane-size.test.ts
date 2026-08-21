import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { clampWidth, usePaneWidth } from "@/lib/pane-size";

/**
 * How wide the shell's two outer columns are.
 *
 * Two things are worth pinning here and neither is arithmetic. The first is
 * that a width survives a reload, because that is the entire reason the pane is
 * draggable rather than responsive. The second is that nothing stored can put a
 * pane outside its bounds — the value comes from localStorage, which anything
 * on the origin can write, and a rail restored at 4000px is an app with no page
 * in it and no divider left on screen to drag back.
 */

const BOUNDS = { initial: 256, min: 200, max: 400 };

beforeEach(() => {
  window.localStorage.clear();
});

describe("clampWidth", () => {
  it("holds a width inside its bounds", () => {
    expect(clampWidth(300, BOUNDS)).toBe(300);
    expect(clampWidth(40, BOUNDS)).toBe(200);
    expect(clampWidth(9000, BOUNDS)).toBe(400);
  });

  it("rounds to whole pixels", () => {
    // A drag produces fractions on a scaled display. Half-pixel column widths
    // are where a one-pixel border turns into a grey blur.
    expect(clampWidth(280.6, BOUNDS)).toBe(281);
  });

  it("treats a width that is not a number as the minimum", () => {
    expect(clampWidth(Number.NaN, BOUNDS)).toBe(200);
  });
});

describe("usePaneWidth", () => {
  it("starts at the default when nothing has been dragged", () => {
    const { result } = renderHook(() => usePaneWidth("rail", BOUNDS));
    expect(result.current[0]).toBe(256);
  });

  it("remembers a width across a remount", () => {
    const first = renderHook(() => usePaneWidth("rail", BOUNDS));
    act(() => first.result.current[1](320));
    expect(first.result.current[0]).toBe(320);

    const second = renderHook(() => usePaneWidth("rail", BOUNDS));
    expect(second.result.current[0]).toBe(320);
  });

  it("keeps the two panes apart", () => {
    const rail = renderHook(() => usePaneWidth("rail", BOUNDS));
    act(() => rail.result.current[1](300));

    const side = renderHook(() => usePaneWidth("side", { initial: 448, min: 320, max: 640 }));
    expect(side.result.current[0]).toBe(448);
  });

  it("clamps a stored width that is out of bounds", () => {
    // Not hypothetical the moment the bounds change: a rail dragged to 400 and
    // then capped at 320 in a later release would otherwise come back too wide
    // for its own limit and never be correctable except by dragging.
    window.localStorage.setItem("recallix.pane.rail", "5000");

    const { result } = renderHook(() => usePaneWidth("rail", BOUNDS));
    expect(result.current[0]).toBe(400);
  });

  it("ignores a stored value that is not a width", () => {
    window.localStorage.setItem("recallix.pane.rail", "wide");

    const { result } = renderHook(() => usePaneWidth("rail", BOUNDS));
    expect(result.current[0]).toBe(256);
  });
});
