import { describe, it, expect, vi } from "vitest";

/**
 * "Meeting not found" is reserved for a meeting that is actually not there.
 *
 * <h2>The bug</h2>
 *
 * <p>The meeting page rendered "Meeting not found" for `isError || !data` — for
 * *any* failure. A dropped connection, a 500, or a request that went out before
 * the auth token was attached all told the user their meeting did not exist.
 *
 * <p>That is false, and it is the most alarming false thing the page could say.
 * The two messages ask for opposite responses: "not found" is final and invites
 * you to give up, while a transient failure wants a retry. Saying the first
 * when you mean the second produces the one reaction that does not recover —
 * closing the tab, believing the data is gone.
 *
 * <p>Note how directly this bug fed the other one in this pair: an
 * unauthenticated request during the hard-refresh race returns 401, and 401 was
 * being rendered as "not found".
 */

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { MeetingLoadError } from "@/components/meeting-load-error";
import { isNotFoundError } from "@/lib/api";

const NOT_FOUND = /meeting not found/i;
const LOAD_FAILED = /couldn.t load this meeting/i;

function renderError(error: unknown, onRetry = vi.fn()) {
  render(<MeetingLoadError error={error} onRetry={onRetry} />);
  return onRetry;
}

describe("MeetingLoadError", () => {
  it("says 'not found' only when the server said 404", () => {
    renderError({ status: 404, data: { message: "No such meeting" } });

    expect(screen.getByText(NOT_FOUND)).toBeInTheDocument();
    expect(screen.queryByText(LOAD_FAILED)).toBeNull();
  });

  it.each([
    ["401 — the token had not been attached yet", { status: 401, data: {} }],
    ["403 — deliberately distinct from 404 in this API", { status: 403, data: {} }],
    ["500 — the server broke", { status: 500, data: {} }],
    ["502 — a bad gateway", { status: 502, data: {} }],
    ["FETCH_ERROR — the network dropped", { status: "FETCH_ERROR", error: "Failed to fetch" }],
    ["TIMEOUT_ERROR — it took too long", { status: "TIMEOUT_ERROR", error: "timed out" }],
    ["PARSING_ERROR — the body was not JSON", { status: "PARSING_ERROR", originalStatus: 200 }],
    ["a thrown Error with no status at all", new Error("boom")],
    ["undefined, because isError can outrun error", undefined],
  ])("does not say 'not found' for %s", (_label, error) => {
    // The regression, and the reason it is a table: every one of these used to
    // render "Meeting not found".
    renderError(error);

    expect(screen.queryByText(NOT_FOUND)).toBeNull();
    expect(screen.getByText(LOAD_FAILED)).toBeInTheDocument();
  });

  it("tells the user the meeting is still there", () => {
    // The specific correction. The old screen's whole problem was implying the
    // opposite, so it is worth asserting the words and not just the heading.
    renderError({ status: 500, data: {} });

    expect(screen.getByText(/still there/i)).toBeInTheDocument();
  });

  it("offers a retry on a transient failure, and calls back when used", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const onRetry = renderError({ status: "FETCH_ERROR", error: "offline" });

    await userEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("offers no retry on a 404, because retrying cannot help", () => {
    renderError({ status: 404, data: {} });

    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  it("announces the failure to assistive technology", () => {
    // This replaces content the reader was waiting for; without a live region
    // somebody who has already moved on never learns it did not arrive.
    renderError({ status: 500, data: {} });

    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("always offers the way back", () => {
    for (const error of [{ status: 404, data: {} }, { status: 500, data: {} }]) {
      const { unmount } = render(<MeetingLoadError error={error} onRetry={vi.fn()} />);
      expect(screen.getByRole("link", { name: /back to your conversations/i })).toBeInTheDocument();
      unmount();
    }
  });
});

describe("isNotFoundError", () => {
  it("is true only for a numeric 404", () => {
    expect(isNotFoundError({ status: 404 })).toBe(true);
  });

  it("is false for every other error shape", () => {
    // `"404"` is the interesting one: RTK Query's status is a number for HTTP
    // responses and a string only for transport failures, so a string here
    // would mean something has gone wrong upstream and must not be read as a
    // missing meeting.
    for (const error of [
      { status: 400 },
      { status: 401 },
      { status: 403 },
      { status: 500 },
      { status: "404" },
      { status: "FETCH_ERROR" },
      {},
      null,
      undefined,
      "404",
      404,
      new Error("404"),
    ]) {
      expect(isNotFoundError(error), JSON.stringify(error)).toBe(false);
    }
  });
});
