import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import type { TranscriptSegment } from "@/lib/types";

/**
 * Hoisted, because `vi.mock` is: the component under test imports `sonner` and
 * `@/lib/api` at module scope, so both factories run before any plain `const`
 * in this file has been initialised.
 */
const mocks = vi.hoisted(() => ({
  edit: vi.fn(),
  unwrap: vi.fn(() => Promise.resolve({}) as Promise<unknown>),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  useEditSegmentsMutation: () => [
    (a: unknown) => {
      mocks.edit(a);
      return { unwrap: mocks.unwrap };
    },
    { isLoading: false },
  ],
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

const { edit, toastError } = mocks;

import {
  TranscriptEditor,
  type TranscriptEditorHandle,
  type TranscriptEditorStatus,
} from "@/components/transcript-editor";

/**
 * Correcting a transcript in one pass.
 *
 * The failures worth protecting against here are all about work going missing.
 * A batch that half-applies leaves a transcript nobody meant; a failed save
 * that closes the editor throws away every correction the user typed; a Cancel
 * that does not ask does the same thing faster. Each of those saves cleanly in
 * the naive implementation and is only visible as "the app lost my edits".
 */
function segment(over: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: "seg_1",
    start: 0,
    end: 4,
    speaker: "Priya",
    text: "We should ship on Thursday.",
    ...over,
  };
}

const SEGMENTS: TranscriptSegment[] = [
  segment(),
  segment({ id: "seg_2", start: 4, end: 9, text: "Rick is on holiday though." }),
  segment({ id: "seg_3", start: 9, end: 14, speaker: "Marcus", text: "Then Friday." }),
];

beforeEach(() => {
  edit.mockClear();
  toastError.mockClear();
  mocks.toastSuccess.mockClear();
  mocks.unwrap.mockReset().mockResolvedValue({});
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

function editor(segments = SEGMENTS) {
  const onClose = vi.fn();
  const status: TranscriptEditorStatus[] = [];
  const ref = React.createRef<TranscriptEditorHandle>();
  render(
    <TranscriptEditor
      ref={ref}
      meetingId="mtg_1"
      segments={segments}
      onStatus={(s) => status.push(s)}
      onClose={onClose}
    />,
  );
  return { onClose, status, ref };
}

function lineFor(text: string): HTMLTextAreaElement {
  const found = screen
    .getAllByRole("textbox")
    .find((el) => (el as HTMLTextAreaElement).value === text);
  if (!found) throw new Error(`No line reading “${text}”`);
  return found as HTMLTextAreaElement;
}

describe("TranscriptEditor", () => {
  it("opens every line at once, which is the whole point of a mode", () => {
    editor();
    expect(screen.getAllByRole("textbox")).toHaveLength(3);
  });

  it("keeps the speaker and the timecode as context rather than as fields", () => {
    editor();
    expect(screen.getByText("Priya")).toBeInTheDocument();
    expect(screen.getByText("Marcus")).toBeInTheDocument();
    // Reading the row is how you know the correction is going on the right
    // line; typing in it is a different repair with a different scope.
    expect(screen.queryByDisplayValue("Priya")).not.toBeInTheDocument();
  });

  it("sends every change as one batch", async () => {
    const user = userEvent.setup();
    const { ref } = editor();

    await user.clear(lineFor("We should ship on Thursday."));
    await user.type(lineFor(""), "We should ship on Tuesday.");
    await user.clear(lineFor("Then Friday."));
    await user.type(lineFor(""), "Then Monday.");

    await act(async () => {
      await ref.current!.save();
    });

    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0][0]).toEqual({
      id: "mtg_1",
      edits: [
        { id: "seg_1", text: "We should ship on Tuesday." },
        { id: "seg_3", text: "Then Monday." },
      ],
    });
  });

  it("leaves untouched lines out of the batch", async () => {
    const user = userEvent.setup();
    const { ref } = editor();
    await user.type(lineFor("Then Friday."), "!");
    await act(async () => {
      await ref.current!.save();
    });
    expect(edit.mock.calls[0][0].edits).toHaveLength(1);
  });

  it("counts a line typed back to its original as unchanged", async () => {
    const user = userEvent.setup();
    const { ref, onClose } = editor();
    const line = lineFor("Then Friday.");
    await user.type(line, "!");
    await user.type(line, "{backspace}");

    await act(async () => {
      await ref.current!.save();
    });
    // Nothing to send, so nothing is sent — and the mode closes, because Done
    // with no changes is still Done.
    expect(edit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("publishes the unsaved count for the toolbar outside it", async () => {
    const user = userEvent.setup();
    const { status } = editor();
    await user.type(lineFor("Then Friday."), "!");
    await waitFor(() => expect(status[status.length - 1].dirty).toBe(1));
  });

  it("stays open with the drafts intact when the save is refused", async () => {
    const user = userEvent.setup();
    mocks.unwrap.mockRejectedValue(new Error("stale"));
    const { ref, onClose } = editor();

    await user.type(lineFor("Then Friday."), "!");
    await act(async () => {
      await ref.current!.save();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
    // The batch is refused whole, so the words the user typed are the only copy
    // of them that exists.
    expect(lineFor("Then Friday.!")).toBeInTheDocument();
  });

  it("asks before discarding, and stays put when told no", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { ref, onClose } = editor();

    await user.type(lineFor("Then Friday."), "!");
    let closed = true;
    act(() => {
      closed = ref.current!.cancel();
    });

    expect(closed).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(lineFor("Then Friday.!")).toBeInTheDocument();
  });

  it("does not ask when there is nothing to discard", () => {
    const confirm = vi.spyOn(window, "confirm");
    const { ref, onClose } = editor();
    let closed = false;
    act(() => {
      closed = ref.current!.cancel();
    });
    expect(closed).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("undoes one line without costing the others", async () => {
    const user = userEvent.setup();
    const { ref } = editor();

    await user.type(lineFor("We should ship on Thursday."), "!");
    await user.type(lineFor("Then Friday."), "?");
    await user.click(screen.getByLabelText("Undo changes to the line at 00:00"));
    await act(async () => {
      await ref.current!.save();
    });

    expect(edit.mock.calls[0][0].edits).toEqual([{ id: "seg_3", text: "Then Friday.?" }]);
  });

  it("shows a line with no id as text, rather than as a box that drops what is typed", () => {
    editor([segment({ id: undefined, text: "An older transcript line." })]);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("An older transcript line.")).toBeInTheDocument();
  });

  it("says what correcting a line costs before it is corrected", () => {
    editor();
    expect(screen.getByText(/loses its per-word timings/)).toBeInTheDocument();
    expect(screen.getByText(/marks it out of date/)).toBeInTheDocument();
  });
});
