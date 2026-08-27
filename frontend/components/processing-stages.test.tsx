import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProcessingStages } from "@/components/processing-stages";
import { processingStages } from "@/lib/processing-stages";

/**
 * Which parts of a meeting are made, and which are still coming.
 *
 * <p>The accessibility requirement is the substance here, not decoration:
 * progress must not rely on colour. A green circle beside "Transcript" says
 * nothing to a reader who cannot see green, and nothing at all to a screen
 * reader — so each stage carries an icon *and* its state in words.
 */
describe("the stage strip", () => {
  it("names every stage", () => {
    render(<ProcessingStages stages={processingStages({ status: "TRANSCRIBING" })} />);

    for (const label of ["Uploaded", "Transcript", "Speakers", "Summary"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("says each stage's state in words, not only in colour", () => {
    render(<ProcessingStages stages={processingStages({ status: "SUMMARIZING" })} />);

    // Uploaded and Transcript and Speakers are done; Summary is in progress.
    expect(screen.getAllByText(", done")).toHaveLength(3);
    expect(screen.getByText(", in progress")).toBeInTheDocument();
  });

  it("marks the stages of a queued meeting as waiting", () => {
    render(<ProcessingStages stages={processingStages({ status: "QUEUED" })} />);

    expect(screen.getAllByText(", waiting")).toHaveLength(2);
  });

  it("is an ordered list, because the order is the information", () => {
    render(<ProcessingStages stages={processingStages({ status: "QUEUED" })} />);

    expect(screen.getByRole("list").tagName).toBe("OL");
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });

  it("shows nothing in progress for a finished meeting", () => {
    render(<ProcessingStages stages={processingStages({ status: "READY" })} />);

    expect(screen.queryByText(", in progress")).not.toBeInTheDocument();
    expect(screen.getAllByText(", done")).toHaveLength(4);
  });

  it("shows nothing in progress for a failed one either", () => {
    // Nothing may keep spinning under an error message.
    render(<ProcessingStages stages={processingStages({ status: "FAILED" })} />);

    expect(screen.queryByText(", in progress")).not.toBeInTheDocument();
  });
});
