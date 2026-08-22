import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as React from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { useThreadScroll } from "@/lib/use-thread-scroll";

/**
 * Following the newest turn, and knowing when to stop.
 *
 * Sticking to the bottom on every render is right while an answer is arriving
 * and wrong the moment somebody scrolls up to re-read a citation three
 * exchanges back: they get one line of it before being pulled to the end again.
 *
 * jsdom has no layout, so the geometry is set by hand — which is fine, because
 * what is under test is the decision, not the scrolling.
 */

const scrollTo = vi.fn();

function Thread({ deps }: { deps: React.DependencyList }) {
  const ref = useThreadScroll(deps);
  return <div ref={ref} data-testid="thread" />;
}

function place(el: HTMLElement, { scrollTop, scrollHeight = 1000, clientHeight = 400 }: {
  scrollTop: number;
  scrollHeight?: number;
  clientHeight?: number;
}) {
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  Object.defineProperty(el, "scrollTop", { value: scrollTop, configurable: true, writable: true });
}

beforeEach(() => {
  scrollTo.mockClear();
  // jsdom implements no layout and therefore no element `scrollTo`. The hook
  // guards for that; here it is stubbed so the call can be observed.
  (Element.prototype as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
});

afterEach(() => {
  delete (Element.prototype as unknown as { scrollTo?: unknown }).scrollTo;
});

describe("useThreadScroll", () => {
  it("follows a new turn when the reader is at the bottom", () => {
    const { getByTestId, rerender } = render(<Thread deps={[1]} />);
    place(getByTestId("thread"), { scrollTop: 600 });
    scrollTo.mockClear();

    rerender(<Thread deps={[2]} />);

    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });
  });

  it("stops following once the reader scrolls up", () => {
    const { getByTestId, rerender } = render(<Thread deps={[1]} />);
    const thread = getByTestId("thread");
    place(thread, { scrollTop: 100 });

    act(() => {
      fireEvent.scroll(thread);
    });
    scrollTo.mockClear();
    rerender(<Thread deps={[2]} />);

    // Five hundred pixels from the bottom, mid-answer. Yanking them back is
    // the behaviour that makes a long answer unreadable while it is arriving.
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("follows again when the reader returns to the bottom", () => {
    const { getByTestId, rerender } = render(<Thread deps={[1]} />);
    const thread = getByTestId("thread");

    place(thread, { scrollTop: 100 });
    act(() => fireEvent.scroll(thread));
    place(thread, { scrollTop: 600 });
    act(() => fireEvent.scroll(thread));
    scrollTo.mockClear();
    rerender(<Thread deps={[2]} />);

    // Scrolling back down *is* the "jump to latest" gesture. A separate button
    // would be a second way to say the same thing.
    expect(scrollTo).toHaveBeenCalled();
  });

  it("treats a nudge of a few pixels as still following", () => {
    const { getByTestId, rerender } = render(<Thread deps={[1]} />);
    const thread = getByTestId("thread");

    // Browsers disagree about `scrollHeight - scrollTop - clientHeight` at
    // fractional zoom, so an exact-bottom test unsticks on a rounding error.
    place(thread, { scrollTop: 570 });
    act(() => fireEvent.scroll(thread));
    scrollTo.mockClear();
    rerender(<Thread deps={[2]} />);

    expect(scrollTo).toHaveBeenCalled();
  });

  it("scrolls the thread and never the page", () => {
    const { getByTestId, rerender } = render(<Thread deps={[1]} />);
    const thread = getByTestId("thread");
    place(thread, { scrollTop: 600 });
    scrollTo.mockClear();

    rerender(<Thread deps={[2]} />);

    // `scrollIntoView` walks every scrollable ancestor including the document,
    // which is how a chat panel came to drag a whole meeting page down as its
    // history loaded. Setting scrollTop on this element cannot reach the window.
    expect(scrollTo.mock.instances[0]).toBe(thread);
  });
});
