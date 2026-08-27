import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProcessingCard } from "@/components/processing-card";

/**
 * The wait, on the meeting's own page, as a banner rather than as the page.
 *
 * <p>This used to be a full-width Card, and because everything else on a
 * meeting's page is gated on READY it was the only thing rendered -- so saving a
 * forty-minute recording turned the app into a progress screen. The job is
 * followed by the docked bar in the shell now (components/processing-dock), and
 * this is the one row that says so on the meeting itself.
 *
 * <p>What had to survive the change is Stop: this page carries the only control
 * that ends a pipeline. And Stop must not appear where it does not belong -- it
 * deletes the meeting, the worker being mid-flight and unrecallable -- so on a
 * file somebody imported an hour ago it would be a delete button dressed as a
 * cancel.
 */
describe("ProcessingCard", () => {
  it("says which stage it is on and how far through", () => {
    render(<ProcessingCard status="TRANSCRIBING" progress={37} />);

    expect(screen.getByText(/Transcribing/i)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    // In figures, not only as a length. A bar says "something is happening";
    // the number is the one that answers "how much longer".
    expect(screen.getByText("37%")).toBeInTheDocument();
  });

  it("rounds the worker's estimate rather than printing it raw", () => {
    render(<ProcessingCard status="TRANSCRIBING" progress={37.4999} />);

    // Stage estimates are not whole numbers, and "37.4999%" reads as a bug in
    // the one number somebody is watching.
    expect(screen.getByText("37%")).toBeInTheDocument();
  });

  it.each([
    [-10, "0%"],
    [140, "100%"],
  ])("clamps a progress of %s to %s", (progress, shown) => {
    render(<ProcessingCard status="SUMMARIZING" progress={progress} />);

    expect(screen.getByText(shown)).toBeInTheDocument();
  });

  it("says what is happening rather than leaving the bar to speak for itself", () => {
    render(<ProcessingCard status="QUEUED" progress={5} />);

    // A bar with no words is a page that has stopped explaining itself. The
    // stage sentence is derived from the reported status, not from the bar --
    // see lib/processing-stages.
    expect(screen.getByText("Preparing to process…")).toBeInTheDocument();
  });

  it("says the work does not need this page to stay open", () => {
    // The complaint this whole change answers was somebody believing they had
    // to sit on the page for transcription to continue.
    render(<ProcessingCard status="TRANSCRIBING" progress={30} />);

    expect(
      screen.getByText("You can leave this page. Processing continues automatically."),
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
