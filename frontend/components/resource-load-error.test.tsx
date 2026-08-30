import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { ResourceLoadError } from "@/components/resource-load-error";

/**
 * The screen that was missing from three panels.
 *
 * <p>Without it a failed transcript, summary or action-items request fell
 * through to that panel's empty message — "Transcript unavailable.", "No summary
 * available.", "No action items were extracted." — which are opposite claims
 * with opposite responses. One says wait a moment; the other says your data is
 * gone.
 */

function show(props: Partial<React.ComponentProps<typeof ResourceLoadError>> = {}) {
  const onRetry = props.onRetry ?? vi.fn();
  render(
    <ResourceLoadError
      title="Couldn't load the summary"
      detail="Your summary is still here. Something went wrong loading it."
      onRetry={onRetry}
      {...props}
    />,
  );
  return onRetry;
}

describe("ResourceLoadError", () => {
  it("names what failed", () => {
    show();

    expect(screen.getByText("Couldn't load the summary")).toBeInTheDocument();
  });

  it("says the resource is still there, which is the correction", () => {
    // The whole difference from the empty message it replaced. A reader who
    // believes the summary is gone closes the tab, and that is the one reaction
    // that does not recover.
    show();

    expect(screen.getByText(/still here/i)).toBeInTheDocument();
  });

  it("offers a retry and calls back when it is used", async () => {
    const onRetry = show();

    await userEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("cannot be queued up while a retry is already running", async () => {
    const onRetry = show({ retrying: true });

    const button = screen.getByRole("button", { name: /try again/i });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("announces itself to assistive technology", () => {
    // It replaces content the reader was waiting for; somebody who has already
    // moved on would otherwise never learn it did not arrive.
    show();

    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("keeps backend detail off the screen", () => {
    // No status code, no server message, no URL. The cause is in the network
    // tab for whoever wants it; on the page it describes the shape of the
    // backend to anybody who can reach the page.
    show({ detail: "Your summary is still here. Something went wrong loading it." });

    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\b(4\d\d|5\d\d)\b/);
    expect(text).not.toMatch(/http|fetch|api\/v1/i);
  });
});
