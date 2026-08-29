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

/**
 * jsdom implements no Pointer Events API.
 *
 * Radix's Select asks the element it is opening whether it currently has
 * pointer capture, which throws rather than returning false. The failure names
 * `hasPointerCapture` and surfaces as an unhandled exception outside the test
 * that caused it, so a filter dropdown that works perfectly in a browser breaks
 * an unrelated assertion several tests later.
 *
 * Capture is meaningless without a real pointer, so "nothing is captured" is
 * both the honest answer and the one the component needs.
 */
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

/**
 * jsdom has no media pipeline: `play()` throws "not implemented" and `pause()`
 * does nothing observable.
 *
 * Stubbed to the smallest thing that behaves like a player — a settable
 * `paused` that the real events would drive — so the controls can be tested for
 * what they ask the element to do. What the element then does with it is the
 * browser's business, and is not something jsdom could tell us anyway.
 */
Object.defineProperty(HTMLMediaElement.prototype, "paused", {
  configurable: true,
  get(this: HTMLMediaElement & { _paused?: boolean }) {
    return this._paused ?? true;
  },
});

HTMLMediaElement.prototype.play = function play(
  this: HTMLMediaElement & { _paused?: boolean },
) {
  this._paused = false;
  this.dispatchEvent(new Event("play"));
  return Promise.resolve();
};

HTMLMediaElement.prototype.pause = function pause(
  this: HTMLMediaElement & { _paused?: boolean },
) {
  this._paused = true;
  this.dispatchEvent(new Event("pause"));
};

/**
 * jsdom implements no scrolling at all, so `Element.scrollTo` is missing.
 *
 * The chat panels call it to keep the newest message in view — deliberately,
 * rather than `scrollIntoView` on a sentinel, which walks every scrollable
 * ancestor including the document and drags the whole page down. A no-op here
 * keeps that code honest: it is a real browser API and the test environment,
 * not the component, is the thing that lacks it.
 */
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function scrollTo() {
    /* jsdom has no layout, so there is nothing to scroll. */
  };
}


/**
 * jsdom implements no layout, so there is nothing to observe a resize of.
 *
 * The composer watches its own width so it can re-measure the box when the
 * side panel is dragged, or when the panel it lives in comes back on screen —
 * neither of which is a render of the composer. Unstubbed, `new
 * ResizeObserver` is a ReferenceError inside a `useEffect`, which surfaces as
 * every chat test failing on a name that has nothing to do with what they are
 * testing.
 *
 * A no-op is the honest stand-in: jsdom will never resize anything, so an
 * observer that never fires is exactly right.
 */
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {
      /* nothing here has a size */
    }
    unobserve() {}
    disconnect() {}
  };
}

/**
 * jsdom's `Blob` has no `arrayBuffer()`.
 *
 * Every browser has had it since 2019, and the export bundler uses it to read
 * each rendered document back out before writing it into a zip. Without this,
 * `lib/zip.test.ts` and `lib/exports.test.ts` fail on a method that exists
 * everywhere the code actually runs.
 *
 * Built on `FileReader`, which jsdom does implement, so the bytes really do
 * round-trip through jsdom's own Blob rather than through a stand-in that might
 * agree with the test and not with a browser.
 */
if (typeof Blob !== "undefined" && !Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}
