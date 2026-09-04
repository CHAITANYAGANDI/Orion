import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpeakerEditor } from "@/components/speaker-editor";
import type { SpeakerStats } from "@/lib/types";

/**
 * The two repairs a user reaches for on seeing the speakers are wrong.
 *
 * Rename answers "Speaker 2 is Priya". Merge answers "Speaker 3 is *also*
 * Priya" — one voice the provider split across two labels, which renaming
 * cannot fix because naming both labels the same thing leaves two canonical
 * speakers wearing one name.
 *
 * Most of what is asserted here is restraint. A merge cannot be undone, so the
 * panel must not let a stray click start one, must not offer a pair that means
 * nothing, and must say what it is about to do in the words of the two people
 * involved.
 */
function stats(over: Partial<SpeakerStats> & { speaker: string }): SpeakerStats {
  return {
    speakerKey: `spk_${over.speaker.replace(/\D/g, "") || "x"}`,
    speakingSeconds: 60,
    percentage: 50,
    segmentCount: 4,
    wordCount: 40,
    ...over,
  };
}

const PRIYA = stats({ speaker: "Priya", speakerKey: "spk_1" });
const MARCUS = stats({ speaker: "Marcus", speakerKey: "spk_2" });
const THIRD = stats({ speaker: "Speaker 3", speakerKey: "spk_3" });

function setup(over: Partial<React.ComponentProps<typeof SpeakerEditor>> = {}) {
  const onRename = vi.fn();
  const onMerge = vi.fn();
  render(
    <SpeakerEditor
      speakers={[PRIYA, MARCUS, THIRD]}
      onRename={onRename}
      onMerge={onMerge}
      {...over}
    />,
  );
  return { onRename, onMerge };
}

describe("renaming", () => {
  it("sends only the names that actually changed", async () => {
    // A mapping that includes untouched speakers would rewrite every turn of
    // theirs for nothing, and the server re-indexes on any change.
    const user = userEvent.setup();
    const { onRename } = setup();

    await user.type(screen.getByLabelText("New name for Speaker 3"), "Priya");
    await user.click(screen.getByRole("button", { name: /save names/i }));

    expect(onRename).toHaveBeenCalledWith({ "Speaker 3": "Priya" });
  });

  it("ignores a name retyped exactly as it already is", async () => {
    const user = userEvent.setup();
    const { onRename } = setup();

    await user.type(screen.getByLabelText("New name for Priya"), "Priya");
    await user.click(screen.getByRole("button", { name: /save names/i }));

    expect(onRename).toHaveBeenCalledWith({});
  });

  it("trims, so a trailing space is not a different person", async () => {
    const user = userEvent.setup();
    const { onRename } = setup();

    await user.type(screen.getByLabelText("New name for Marcus"), "  Ana  ");
    await user.click(screen.getByRole("button", { name: /save names/i }));

    expect(onRename).toHaveBeenCalledWith({ Marcus: "Ana" });
  });
});

describe("merging", () => {
  it("will not start until both sides are chosen", async () => {
    const user = userEvent.setup();
    setup();

    const button = screen.getByRole("button", { name: /merge speakers/i });
    expect(button).toBeDisabled();

    await user.selectOptions(screen.getByLabelText("Speaker to merge"), "spk_3");
    expect(screen.getByRole("button", { name: /merge/i })).toBeDisabled();
  });

  it("names both people on the button, because there is no undo", async () => {
    const user = userEvent.setup();
    setup();

    await user.selectOptions(screen.getByLabelText("Speaker to merge"), "spk_3");
    await user.selectOptions(screen.getByLabelText("Merge into"), "spk_1");

    expect(
      screen.getByRole("button", { name: "Merge Speaker 3 into Priya" }),
    ).toBeEnabled();
  });

  it("says who disappears before it happens", async () => {
    const user = userEvent.setup();
    setup();

    await user.selectOptions(screen.getByLabelText("Speaker to merge"), "spk_3");
    await user.selectOptions(screen.getByLabelText("Merge into"), "spk_1");

    expect(
      screen.getByText(/Speaker 3 will no longer appear/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  it("sends canonical keys, not display names", async () => {
    // Two people in a meeting can both be called Chris, and a rename would move
    // the name off whoever the merge was meant for.
    const user = userEvent.setup();
    const { onMerge } = setup();

    await user.selectOptions(screen.getByLabelText("Speaker to merge"), "spk_3");
    await user.selectOptions(screen.getByLabelText("Merge into"), "spk_1");
    await user.click(screen.getByRole("button", { name: /merge speaker 3 into priya/i }));

    expect(onMerge).toHaveBeenCalledWith("spk_3", "spk_1");
  });

  it("never offers merging somebody into themselves", async () => {
    const user = userEvent.setup();
    setup();

    await user.selectOptions(screen.getByLabelText("Speaker to merge"), "spk_1");

    const into = screen.getByLabelText("Merge into") as HTMLSelectElement;
    const values = Array.from(into.options).map((o) => o.value);
    expect(values).not.toContain("spk_1");
    expect(values).toContain("spk_2");
  });

  it("is not offered on a transcript with no canonical keys", () => {
    // Stored before speaker keys existed. Renaming still works; merging cannot,
    // and offering a control that must fail is worse than saying why.
    setup({
      speakers: [
        { ...PRIYA, speakerKey: null },
        { ...MARCUS, speakerKey: null },
      ],
    });

    expect(screen.queryByLabelText("Speaker to merge")).toBeNull();
    expect(screen.getByText(/too old to merge/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save names/i })).toBeInTheDocument();
  });

  it("is not offered when there is only one speaker", () => {
    setup({ speakers: [PRIYA] });

    expect(screen.queryByLabelText("Speaker to merge")).toBeNull();
    expect(screen.getByText(/only one speaker/i)).toBeInTheDocument();
  });

  it("cannot be fired twice while one is in flight", () => {
    setup({ merging: true });

    expect(screen.getByRole("button", { name: /merge/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /save names/i })).toBeDisabled();
  });
});
