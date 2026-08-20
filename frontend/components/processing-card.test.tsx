import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProcessingCard } from "@/components/processing-card";

/**
 * The wait, on the meeting's own page.
 *
 * <p>Saving a recording lands here now, so the docked bar stands down and this
 * carries the wait. The thing that has to survive that handover is Stop: the
 * bar held the only control that ends a pipeline, and a bar yielding without
 * passing it on leaves a wait nobody can call off on the one page they are
 * sitting on.
 *
 * <p>The other half is that Stop must not appear where it does not belong. It
 * deletes the meeting — the worker is mid-flight and cannot be recalled — so on
 * a file somebody imported an hour ago it would be a delete button dressed as a
 * cancel.
 */
describe("ProcessingCard", () => {
  it("says which stage it is on and how far through", () => {
    render(<ProcessingCard status="TRANSCRIBING" progress={37} />);

    expect(screen.getByText(/Transcribing/i)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    // In figures, not only as a length. A bar says "something is happening";
    // the number is the one that answers "how much longer".
    expect(screen.getByText("37")).toBeInTheDocument();
  });

  it("rounds the worker's estimate rather than printing it raw", () => {
    render(<ProcessingCard status="TRANSCRIBING" progress={37.4999} />);

    // Stage estimates are not whole numbers, and "37.4999%" reads as a bug in
    // the one number somebody is watching.
    expect(screen.getByText("37")).toBeInTheDocument();
  });

  it.each([
    [-10, "0"],
    [140, "100"],
  ])("clamps a progress of %s to %s", (progress, shown) => {
    render(<ProcessingCard status="SUMMARIZING" progress={progress} />);

    expect(screen.getByText(shown)).toBeInTheDocument();
  });

  it("says what is happening rather than leaving the bar to speak for itself", () => {
    render(<ProcessingCard status="QUEUED" progress={5} />);

    // A bar with no words is a page that has stopped explaining itself.
    expect(
      screen.getByText("Working on your meeting brief. This updates live."),
    ).toBeInTheDocument();
  });

  it("prefers the worker's own words when it has sent some", () => {
    render(
      <ProcessingCard status="TRANSCRIBING" progress={37} message="Generating transcript from audio…" />,
    );

    expect(screen.getByText("Generating transcript from audio…")).toBeInTheDocument();
  });

  it("offers Stop while this is the meeting being saved", async () => {
    const onStop = vi.fn();
    render(<ProcessingCard status="QUEUED" progress={5} onStop={onStop} />);

    await userEvent.click(screen.getByRole("button", { name: /Stop/ }));

    expect(onStop).toHaveBeenCalled();
  });

  it("offers no Stop on a meeting that arrived some other way", () => {
    // What it does is delete the meeting. Beside an import from an hour ago
    // that is a delete button dressed as a cancel.
    render(<ProcessingCard status="TRANSCRIBING" progress={37} />);

    expect(screen.queryByRole("button", { name: /Stop/ })).not.toBeInTheDocument();
  });

  it("cannot be stopped twice while the first one is in flight", () => {
    render(<ProcessingCard status="QUEUED" progress={5} onStop={vi.fn()} stopping />);

    expect(screen.getByRole("button", { name: /Stop/ })).toBeDisabled();
  });
});
