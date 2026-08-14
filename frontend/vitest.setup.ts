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
