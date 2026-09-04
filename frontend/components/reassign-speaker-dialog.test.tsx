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
  const onConfirmNew = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <ReassignSpeakerDialog
      target={TARGET}
      speakers={SPEAKERS}
      onClose={onClose}
      onConfirm={onConfirm}
      onConfirmNew={onConfirmNew}
      {...over}
    />,
  );
  return { onConfirm, onConfirmNew, onClose, view };
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

  it("says nobody else can take the words when the meeting has one speaker", () => {
    // It used to end there. It cannot now: the words may belong to somebody
    // diarization never separated out, which is exactly the case a
    // single-speaker meeting is most likely to be.
    show({ speakers: [SPEAKERS[1]] });
    expect(screen.getByText(/isn't listed yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New speaker" })).toBeEnabled();
  });

  it("lists only the speakers the meeting has, above the rule", () => {
    // "New speaker" is deliberately not one of these: it is below a rule and
    // asks again before it does anything, because creating a speaker has
    // consequences reassigning to an existing one does not.
    show();
    const named = screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "")
      // The avatar's initials are inside the button, so the name is not at the
      // start of `textContent`.
      .filter((label) => label.includes("Speaker") && !label.includes("New speaker"));
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

/**
 * "This was somebody else entirely."
 *
 * The fourth speaker repair, and the one the list alone cannot express: a voice
 * diarization never separated out has no entry to pick. Picking from a list that
 * does not contain the person is not a thing a user can do, so before this the
 * correction had no shape at all.
 *
 * <p>It asks twice, and that is the point of these tests. Every other option in
 * this dialog moves words between people who already exist; this one brings a
 * person into the meeting's talk-time chart, summary and exports. It must not be
 * reachable by the stray click the rest of the list is one press away from.
 */
describe("assigning to a speaker who is not in the meeting", () => {
  it("offers New speaker after the existing speakers", () => {
    show();
    const labels = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    const existing = labels.findIndex((l) => l.includes("Speaker 1"));
    const brandNew = labels.findIndex((l) => l.includes("New speaker"));

    expect(brandNew).toBeGreaterThan(existing);
  });

  it("does not create anything on the first press", async () => {
    // One click is a decision to consider it, not to do it.
    const { onConfirmNew } = show();

    await userEvent.click(screen.getByRole("button", { name: "New speaker" }));

    expect(onConfirmNew).not.toHaveBeenCalled();
    expect(screen.getByText("Assign to a new speaker")).toBeInTheDocument();
    expect(screen.getByText(/isn't listed yet/i)).toBeInTheDocument();
  });

  it("creates and assigns on confirmation", async () => {
    const { onConfirmNew } = show();

    await userEvent.click(screen.getByRole("button", { name: "New speaker" }));
    await userEvent.click(screen.getByRole("button", { name: /create & assign/i }));

    expect(onConfirmNew).toHaveBeenCalledTimes(1);
  });

  it("can be backed out of, leaving the list as it was", async () => {
    const { onConfirmNew, onClose } = show();

    await userEvent.click(screen.getByRole("button", { name: "New speaker" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onConfirmNew).not.toHaveBeenCalled();
    // Backing out of the confirm is not closing the dialog: the selection is
    // still there and the existing speakers are the other answer.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Speaker 1/ })).toBeInTheDocument();
  });

  it("cannot be confirmed twice while the request is in flight", async () => {
    // Two presses would allocate two identities for one correction.
    const onConfirmNew = vi.fn();
    const props = {
      target: TARGET,
      speakers: SPEAKERS,
      onClose: vi.fn(),
      onConfirm: vi.fn(),
      onConfirmNew,
    };
    const { rerender } = render(<ReassignSpeakerDialog {...props} />);

    await userEvent.click(screen.getByRole("button", { name: "New speaker" }));
    rerender(<ReassignSpeakerDialog {...props} busy />);

    const confirm = screen.getByRole("button", { name: /create & assign/i });
    expect(confirm).toBeDisabled();
    await userEvent.click(confirm).catch(() => {});
    expect(onConfirmNew).not.toHaveBeenCalled();
  });

  it("announces a failure without closing", async () => {
    const { onClose } = show({ error: "There is no such speaker in this meeting" });

    expect(screen.getByRole("alert")).toHaveTextContent(/no such speaker/i);
    expect(onClose).not.toHaveBeenCalled();
    // And the selection is still correctable: the buttons are all still there.
    expect(screen.getByRole("button", { name: "New speaker" })).toBeEnabled();
  });

  it("shows the failure on the confirm step too", async () => {
    show({ error: "Could not change the speaker on that line." });
    await userEvent.click(screen.getByRole("button", { name: "New speaker" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/could not change/i);
  });

  it("still lets an existing speaker be chosen", async () => {
    // The addition must not have cost the ordinary answer.
    const { onConfirm } = show();

    await userEvent.click(screen.getByRole("button", { name: /Speaker 1/ }));

    expect(onConfirm).toHaveBeenCalledWith("spk_1");
  });
});
