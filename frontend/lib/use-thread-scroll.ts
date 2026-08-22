"use client";

/**
 * Keep the newest turn in view, unless the reader is somewhere else.
 *
 * ## Two things this must not do
 *
 * **It must not scroll the page.** The first version called `scrollIntoView` on
 * a sentinel at the end of the thread, which scrolls *every* scrollable
 * ancestor including the document — so opening a meeting scrolled the whole
 * window down to the bottom of the chat panel the moment its history loaded,
 * and the summary the reader had come for started off screen. Setting
 * `scrollTop` on the thread's own element cannot reach the window.
 *
 * **It must not fight the reader.** Sticking to the bottom on every render is
 * right while an answer is arriving and wrong the moment somebody scrolls up to
 * re-read the citation three exchanges back: they get one line of it before
 * being yanked to the end again. So the thread follows only while it is already
 * near the bottom, which is the standard behaviour and the one people expect
 * without noticing it.
 *
 * Scrolling back down re-arms it. There is no separate "jump to latest"
 * control: returning to the bottom *is* the gesture.
 */

import * as React from "react";

/**
 * How close to the bottom still counts as "following".
 *
 * Generous on purpose. A few pixels would unstick on a rounding error between
 * `scrollHeight` and `scrollTop + clientHeight`, which browsers do not agree
 * about at fractional zoom; a hundred is roughly one wrapped line of an answer,
 * so somebody who nudges the wheel once is still following.
 */
const NEAR_BOTTOM_PX = 100;

/**
 * @param deps what changing means there is something new to scroll to —
 *   normally the messages and whether a question is in flight
 * @returns the ref to put on the scrolling element
 */
export function useThreadScroll(deps: React.DependencyList) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  // Not state: this changes on every scroll event, and re-rendering the whole
  // thread while somebody drags a scrollbar is how a conversation gets janky.
  const following = React.useRef(true);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      following.current =
        el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || !following.current) return;
    // jsdom has no layout and no `scrollTo` on elements. Guarded rather than
    // stubbed in every test that happens to render a thread.
    if (typeof el.scrollTo !== "function") return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}
