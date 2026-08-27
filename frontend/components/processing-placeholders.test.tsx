import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  ProcessingSummary,
  ProcessingTranscript,
  ProcessingActionItems,
  ProcessingChatRail,
} from "@/components/processing-placeholders";

/**
 * What each area says while its data does not exist yet.
 *
 * <p>The failure these replace was a category error, not a wording problem. A
 * meeting still being transcribed showed "No summary available" and an empty
 * transcript — statements about a *finished* meeting that turned out to contain
 * nothing. A pending result and an empty result are different facts, and the
 * page gave them the same words.
 */
describe("the summary placeholder", () => {
  it("says the summary is waiting on the transcript, before there is one", () => {
    render(<ProcessingSummary stage="waiting" />);

    expect(screen.getByText(/Summary is waiting for the transcript/)).toBeInTheDocument();
  });

  it("says it is being generated once the transcript is there", () => {
    render(<ProcessingSummary stage="generating" />);

    expect(screen.getByText(/Generating summary/)).toBeInTheDocument();
    // And points at what can be read in the meantime, which is the whole gain.
    expect(screen.getByText(/transcript is ready and can be read now/)).toBeInTheDocument();
  });

  it("never says the summary is unavailable", () => {
    for (const stage of ["waiting", "generating"] as const) {
      const { container, unmount } = render(<ProcessingSummary stage={stage} />);
      expect(container.textContent).not.toMatch(/No summary available/);
      unmount();
    }
  });

  it("marks itself busy, so it is not read as finished content", () => {
    const { container } = render(<ProcessingSummary stage="generating" />);

    expect(container.querySelector("[aria-busy]")).not.toBeNull();
  });
});

describe("the transcript placeholder", () => {
  it("says the transcript is being prepared, and that it will appear here", () => {
    render(<ProcessingTranscript />);

    expect(screen.getByText(/Transcript is being prepared/)).toBeInTheDocument();
    expect(screen.getByText(/as soon as transcription finishes/)).toBeInTheDocument();
  });

  it("is not an empty transcript", () => {
    // An empty transcript looks like a recording that captured nothing, which
    // is the one conclusion that must not be drawn here.
    const { container } = render(<ProcessingTranscript />);

    expect(container.textContent).not.toMatch(/no transcript/i);
    expect(container.querySelector("[aria-busy]")).not.toBeNull();
  });
});

describe("the action items placeholder", () => {
  it("waits for the transcript before promising extraction", () => {
    render(<ProcessingActionItems ready={false} />);

    expect(
      screen.getByText("Action items will be extracted after the transcript is ready."),
    ).toBeInTheDocument();
  });

  it("says extraction is under way once the transcript exists", () => {
    render(<ProcessingActionItems ready />);

    expect(screen.getByText(/Extracting action items/)).toBeInTheDocument();
  });

  it("never says none were extracted", () => {
    // That is the finished-and-genuinely-none message, and it is still shown —
    // by the page, for a READY meeting. Not here.
    const { container } = render(<ProcessingActionItems ready />);

    expect(container.textContent).not.toMatch(/No action items were extracted/);
  });
});

describe("the chat rail placeholder", () => {
  it("says when the chat becomes available, and why it is not yet", () => {
    render(<ProcessingChatRail />);

    expect(
      screen.getByText("AI Chat will be available once the transcript is ready."),
    ).toBeInTheDocument();
    expect(screen.getByText(/nothing for it to read yet/)).toBeInTheDocument();
  });

  it("offers no composer to type a question nobody can answer", () => {
    // A box that takes a question and cannot answer it is worse than no box: it
    // invites the question and then loses it.
    render(<ProcessingChatRail />);

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
