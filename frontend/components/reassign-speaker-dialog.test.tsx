import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReassignSpeakerDialog } from "@/components/reassign-speaker-dialog";
import type { SpeakerStats } from "@/lib/types";

/**
 * The dialog that corrects one attribution.
 *
 * What matters here is restraint: it must show exactly what is moving, offer
 * only people who are already in the meeting, and never present the speaker who
 * already owns the words as somewhere to move them to.
 */
const SPEAKERS: SpeakerStats[] = [
  { speaker: "Speaker 1", speakerKey: "spk_1", speakingSeconds: 30, percentage: 50, segmentCount: 4, wordCount: 60 },
  { speaker: "Speaker 2", speakerKey: "spk_2", speakingSeconds: 30, percentage: 50, segmentCount: 4, wordCount: 60 },
];

const TARGET = {
  segmentId: "seg_1",
  fromWord: 5,
  toWord: 6,
  quote: "Yes, sir.",
  currentKey: "spk_2",
};

function show(over: Partial<React.ComponentProps<typeof ReassignSpeakerDialog>> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <ReassignSpeakerDialog
      target={TARGET}
      speakers={SPEAKERS}
      onClose={onClose}
      onConfirm={onConfirm}
      {...over}
    />,
  );
  return { onConfirm, onClose, view };
}

describe("ReassignSpeakerDialog", () => {
  it("quotes exactly what is moving", () => {
    // A stray drag moves the wrong words and the transcript still reads
    // plausibly afterwards, so the quote is the only chance to catch it.
    show();
    expect(screen.getByText(/Yes, sir\./)).toBeInTheDocument();
  });

  it("says that nothing else changes", () => {
    show();
    expect(screen.getByText(/Every other turn stays exactly as it is/i)).toBeInTheDocument();
  });

  it("does not offer the speaker who already has these words", () => {
    show();
    expect(screen.queryByRole("button", { name: /Speaker 2/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Speaker 1/ })).toBeInTheDocument();
  });

  it("reports the chosen speaker by key, not by display name", async () => {
    // Names are not unique — two people can both be called Chris — and a
    // rename would break a name-keyed correction.
    const { onConfirm } = show();
    await userEvent.click(screen.getByRole("button", { name: /Speaker 1/ }));
    expect(onConfirm).toHaveBeenCalledWith("spk_1");
  });

  it("offers nobody when the meeting has one speaker", () => {
    show({ speakers: [SPEAKERS[1]] });
    expect(screen.getByText(/nobody to move it to/i)).toBeInTheDocument();
  });

  it("never invents a speaker who is not in the meeting", () => {
    show();
    const named = screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "")
      .filter((t) => t.includes("Speaker"));
    expect(named).toHaveLength(1);
  });

  it("cannot be double-submitted while the save is in flight", async () => {
    const { onConfirm } = show({ busy: true });
    const button = screen.getByRole("button", { name: /Speaker 1/ });
    expect(button).toBeDisabled();
    await userEvent.click(button).catch(() => {});
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("renders nothing until there is something to correct", () => {
    const { view } = show({ target: null });
    expect(screen.queryByText(/Who said this\?/)).not.toBeInTheDocument();
    view.unmount();
  });
});
