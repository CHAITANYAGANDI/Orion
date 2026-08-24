import { describe, it, expect } from "vitest";
import { groupIntoTurns } from "@/lib/turns";
import type { TranscriptSegment } from "@/lib/types";

/**
 * Grouping is by identity, not by the name on screen.
 *
 * The displayed name is the one thing about a speaker that is not stable: two
 * people can carry the same one at once, and unattributed turns all render
 * identically. Merging on it collapses real alternation into a single paragraph
 * attributed to whoever spoke first — the same class of bug as a provider
 * merging two voices, arriving at the last possible moment and after every
 * correction upstream has already been made.
 */
function seg(over: Partial<TranscriptSegment>): TranscriptSegment {
  return {
    start: 0,
    end: 1,
    speaker: "Speaker 1",
    text: "hello",
    ...over,
  } as TranscriptSegment;
}

describe("grouping by speakerKey", () => {
  it("never merges two different keys that share a display name", () => {
    // Both renamed to "Chris". They are still two people, and the transcript
    // has to keep saying so.
    const turns = groupIntoTurns([
      seg({ start: 0, speaker: "Chris", speakerKey: "spk_1", text: "Shall we?" }),
      seg({ start: 1, speaker: "Chris", speakerKey: "spk_2", text: "Yes." }),
      seg({ start: 2, speaker: "Chris", speakerKey: "spk_1", text: "Good." }),
    ]);

    expect(turns).toHaveLength(3);
    expect(turns.map((t) => t.speakerKey)).toEqual(["spk_1", "spk_2", "spk_1"]);
  });

  it("merges the same key even when the name changed mid-transcript", () => {
    const turns = groupIntoTurns([
      seg({ start: 0, speaker: "Speaker 1", speakerKey: "spk_1" }),
      seg({ start: 1, speaker: "Sarah", speakerKey: "spk_1" }),
    ]);

    expect(turns).toHaveLength(1);
  });

  it("keeps two unattributed voices apart", () => {
    // Both render the same words. Only the key says they are different people.
    const turns = groupIntoTurns([
      seg({ start: 0, speaker: "Unknown speaker", speakerKey: "spk_1" }),
      seg({ start: 1, speaker: "Unknown speaker", speakerKey: "spk_2" }),
    ]);

    expect(turns).toHaveLength(2);
  });

  it("preserves a one-word turn between two of somebody else's", () => {
    const turns = groupIntoTurns([
      seg({ start: 0, speaker: "Speaker 1", speakerKey: "spk_1", text: "I'm done." }),
      seg({ start: 1, speaker: "Speaker 2", speakerKey: "spk_2", text: "Exactly." }),
      seg({ start: 2, speaker: "Speaker 1", speakerKey: "spk_1", text: "Let's ship it." }),
    ]);

    expect(turns).toHaveLength(3);
    expect(turns[1].segments[0].text).toBe("Exactly.");
  });

  it("still groups transcripts recorded before keys existed", () => {
    // The name is the only identity those have, and refusing to merge them
    // would reflow every old transcript in the archive.
    const turns = groupIntoTurns([
      seg({ start: 0, speaker: "Speaker 1", speakerKey: undefined }),
      seg({ start: 1, speaker: "Speaker 1", speakerKey: undefined }),
      seg({ start: 2, speaker: "Speaker 2", speakerKey: undefined }),
    ]);

    expect(turns).toHaveLength(2);
  });

  it("does not merge across a migration boundary", () => {
    // One side has a key and the other does not, so they cannot be shown to be
    // the same voice. Only happens mid-migration, and guessing there would put
    // two people in one paragraph.
    const turns = groupIntoTurns([
      seg({ start: 0, speaker: "Speaker 1", speakerKey: "spk_1" }),
      seg({ start: 1, speaker: "Speaker 1", speakerKey: undefined }),
    ]);

    expect(turns).toHaveLength(2);
  });
});
