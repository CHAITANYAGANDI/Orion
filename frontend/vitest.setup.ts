import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * Unmount between tests.
 *
 * Testing Library's queries search the whole document, so a component left
 * mounted by one test is found by the next one's `getByRole`. That produces
 * either a "found multiple elements" failure in an unrelated test or, worse, a
 * pass against the previous test's DOM.
 */
afterEach(() => {
  cleanup();
});

/**
 * jsdom implements no layout, so it has no `scrollIntoView`.
 *
 * Both chats call it to keep the newest message in view. Unstubbed, any test
 * that renders one dies inside a `useEffect` with a TypeError that names the
 * scroll rather than whatever the test was actually about.
 */
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {
    /* no layout to scroll */
  };
}
