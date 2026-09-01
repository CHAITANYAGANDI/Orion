import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TranscriptMoment } from "@/lib/types";

const update = vi.fn();
const remove = vi.fn();
const unwrap = vi.fn(() => Promise.resolve({}));

vi.mock("@/lib/api", () => ({
  useUpdateMomentMutation: () => [
    (a: unknown) => {
      update(a);
      return { unwrap };
    },
    { isLoading: false },
  ],
  useDeleteMomentMutation: () => [
    (a: unknown) => {
      remove(a);
      return { unwrap };
    },
    { isLoading: false },
  ],
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { MomentsPanel } from "@/components/moments-panel";

/**
 * The index of what has been marked on a transcript.
 *
 * The case worth protecting is the orphan. Reverie lets people correct
 * transcript lines, so a highlight can end up attached to words that no longer
 * exist — and the tempting behaviour, hiding it, is the wrong one: to the user
 * that is indistinguishable from the app having thrown their annotation away.
 * It stays in the list, labelled, with the quote and timestamp that still lead
 * back to the moment.
 */
function moment(over: Partial<TranscriptMoment> = {}): TranscriptMoment {
  return {
    id: "mom_1",
    meetingId: "mtg_1",
    kind: "HIGHLIGHT",
    ranges: [{ segmentId: "seg_1", startOffset: 10, endOffset: 14, quote: "ship" }],
    quote: "ship",
    body: "",
    speaker: "Priya",
    startSeconds: 754,
    endSeconds: 760,
    createdAt: "2026-08-13T14:30:00Z",
    updatedAt: "2026-08-13T14:30:00Z",
    ...over,
  };
}

const TEXT = "We should ship on Thursday.";
const intact = () => TEXT;
const rewritten = () => "Entirely different words now.";

beforeEach(() => {
  update.mockClear();
  remove.mockClear();
});

function panel(moments: TranscriptMoment[], segmentText = intact, onSeek = vi.fn()) {
  render(
    <MomentsPanel
      meetingId="mtg_1"
      moments={moments}
      segmentText={segmentText}
      onSeek={onSeek}
    />,
  );
}

describe("MomentsPanel", () => {
  it("says what to do when nothing is marked", () => {
    // An empty list with no explanation reads as a feature that is broken
    // rather than one that is unused.
    panel([]);
    expect(screen.getByText(/select any part of the transcript/i)).toBeInTheDocument();
  });

  it("shows the quote, the speaker and the timecode", () => {
    panel([moment()]);
    expect(screen.getByText(/ship/)).toBeInTheDocument();
    expect(screen.getByText("Priya")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /play from 12:34/i })).toBeInTheDocument();
  });

  it("plays from the mark", async () => {
    const onSeek = vi.fn();
    panel([moment()], intact, onSeek);

    await userEvent.click(screen.getByRole("button", { name: /play from 12:34/i }));

    expect(onSeek).toHaveBeenCalledWith(754);
  });

  it("keeps a mark whose line was rewritten, and says so", () => {
    panel([moment()], rewritten);

    expect(screen.getByText(/ship/)).toBeInTheDocument();
    expect(screen.getByText(/line edited/i)).toBeInTheDocument();
  });

  it("does not label an intact mark", () => {
    panel([moment()], intact);
    expect(screen.queryByText(/line edited/i)).not.toBeInTheDocument();
  });

  it("never labels a bookmark as orphaned", () => {
    // A bookmark is a timestamp. It has no words to lose, so editing the line
    // it points at changes nothing about it.
    panel([moment({ kind: "BOOKMARK", ranges: [], quote: "" })], rewritten);
    expect(screen.queryByText(/line edited/i)).not.toBeInTheDocument();
  });

  it("removes a mark", async () => {
    panel([moment()]);

    await userEvent.click(screen.getByRole("button", { name: /remove mark/i }));

    expect(remove).toHaveBeenCalledWith({ id: "mom_1", meetingId: "mtg_1" });
  });

  it("offers no edit control on a highlight", () => {
    // There is nothing written in one, so an edit box would open onto nothing.
    panel([moment()]);
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
  });

  it("edits a note's text", async () => {
    panel([moment({ kind: "NOTE", body: "Check this with legal" })]);

    await userEvent.click(screen.getByRole("button", { name: /edit note/i }));
    const box = screen.getByRole("textbox");
    await userEvent.clear(box);
    await userEvent.type(box, "Checked — fine");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(update).toHaveBeenCalledWith({
      id: "mom_1",
      meetingId: "mtg_1",
      body: "Checked — fine",
    });
  });

  it("abandons an edit on Escape without saving", async () => {
    panel([moment({ kind: "NOTE", body: "Original" })]);

    await userEvent.click(screen.getByRole("button", { name: /edit note/i }));
    await userEvent.type(screen.getByRole("textbox"), "changed{Escape}");

    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText("Original")).toBeInTheDocument();
  });

  it("does not send an emptied note to a server that will refuse it", async () => {
    // The server rejects a note with no body. Catching it here keeps a toast
    // off the screen for something the user can plainly see.
    panel([moment({ kind: "NOTE", body: "Original" })]);

    await userEvent.click(screen.getByRole("button", { name: /edit note/i }));
    await userEvent.clear(screen.getByRole("textbox"));
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(update).not.toHaveBeenCalled();
  });

  it("lets a bookmark's label be cleared", async () => {
    // Unlike a note, the label was always optional — the mark is the timestamp.
    panel([moment({ kind: "BOOKMARK", ranges: [], quote: "", body: "Worth revisiting" })]);

    await userEvent.click(screen.getByRole("button", { name: /edit label/i }));
    await userEvent.clear(screen.getByRole("textbox"));
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(update).toHaveBeenCalledWith({ id: "mom_1", meetingId: "mtg_1", body: "" });
  });
});
