import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TranslatedTranscript } from "@/components/translated-transcript";
import type { MeetingTranslation, TranscriptSegment } from "@/lib/types";

/**
 * The transcript read in another language.
 *
 * <p>Read-only on purpose, and the tests say why: correcting, highlighting and
 * quoting all record exact words or character offsets, and running any of them
 * against translated text saves something that was never said. So this view
 * plays and reads, and points at the original for everything else.
 *
 * <p>The other property under test is that only the words come from the
 * translation. Speaker, timing and order are read from the live segments, so a
 * speaker renamed after a translation was made is renamed in every language at
 * once rather than in none of them.
 */
const SEGMENTS: TranscriptSegment[] = [
  { id: "seg_1", start: 0, end: 8, speaker: "Priya", text: "Shall we start?" },
  { id: "seg_2", start: 942, end: 968, speaker: "Marcus", text: "I'll draft the rollout plan." },
];

function translation(over: Partial<MeetingTranslation> = {}): MeetingTranslation {
  return {
    language: "es",
    languageName: "Spanish",
    rightToLeft: false,
    shortSummary: "",
    detailedSummary: "",
    keyPoints: [],
    sections: [],
    actionItems: [],
    segments: [
      { id: "seg_1", text: "¿Empezamos?" },
      { id: "seg_2", text: "Yo redactaré el plan de despliegue." },
    ],
    hasBrief: true,
    hasTranscript: true,
    stale: false,
    ...over,
  };
}

function view(over: Partial<MeetingTranslation> = {}, onSeek = vi.fn()) {
  const result = render(
    <TranslatedTranscript
      segments={SEGMENTS}
      translation={translation(over)}
      currentTime={0}
      onSeek={onSeek}
      onShowOriginal={vi.fn()}
    />,
  );
  return { ...result, onSeek };
}

describe("TranslatedTranscript", () => {
  it("shows the translation rather than the original", () => {
    view();

    expect(screen.getByText("¿Empezamos?")).toBeInTheDocument();
    expect(screen.queryByText("Shall we start?")).not.toBeInTheDocument();
  });

  it("takes the speaker and the timing from the live transcript", () => {
    view();

    // Not stored with the translation: a speaker renamed afterwards must be
    // renamed in every language, not just in the one that was regenerated.
    expect(screen.getByText("Marcus")).toBeInTheDocument();
    expect(screen.getByText("15:42")).toBeInTheDocument();
  });

  it("plays from the moment a line was said", async () => {
    const { onSeek } = view();

    await userEvent.click(screen.getByRole("button", { name: /Play from 15:42/ }));

    expect(onSeek).toHaveBeenCalledWith(942);
  });

  it("shows a line the translation does not cover in the original", () => {
    // Recorded after the translation was made. A gap would be worse than
    // English: a missing line in a transcript reads as a silence in the room.
    view({ segments: [{ id: "seg_1", text: "¿Empezamos?" }] });

    expect(screen.getByText("I'll draft the rollout plan.")).toBeInTheDocument();
  });

  it("searches the words on screen, not the ones underneath", async () => {
    view();

    await userEvent.type(screen.getByLabelText("Search the translated transcript"), "despliegue");

    expect(screen.getByText(/plan de despliegue/)).toBeInTheDocument();
    expect(screen.queryByText("¿Empezamos?")).not.toBeInTheDocument();
  });

  it("lays out a right-to-left language right-to-left", () => {
    const { container } = view({ rightToLeft: true, languageName: "Arabic" });

    // Not merely cosmetic: Arabic laid out left-to-right is hard to read.
    expect(container.querySelector("ol")).toHaveAttribute("dir", "rtl");
  });

  it("says where to go to correct or highlight something", () => {
    view();

    // Editing translated text would overwrite the recording's actual words
    // with a translation of them, which nobody could detect afterwards.
    expect(screen.getByText(/work on the original/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Show the original/ })).toBeInTheDocument();
  });

  it("offers no way to edit a line", () => {
    view();

    expect(screen.queryByRole("textbox", { name: /edit/i })).not.toBeInTheDocument();
  });
});
