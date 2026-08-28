/**
 * A real streaming session, replayed.
 *
 * Every message below was captured from an actual AssemblyAI Universal-Streaming
 * session — the turn order, the labels, the timings and the revision are the
 * provider's, transcribed verbatim from the wire. The audio was two Windows TTS
 * voices spliced from separate takes, so the ground truth is exact:
 *
 *     0.00-18.34  voice A   (a long continuous turn)
 *    18.34-19.83  voice B   "Exactly."
 *    19.83-26.02  voice A
 *    26.02-28.25  voice B   "Yes, I agree."
 *    28.25-32.71  voice A
 *
 * The synthetic tests in live-turns.test.ts describe shapes the code has to
 * survive. This one describes what the provider actually sends, and it is here
 * because both reported bugs are only visible in that sequence:
 *
 *  - The provider does **not** name the interjections in the Turn message. It
 *    sends `speaker_label: "PENDING"` and names them later, in a separate
 *    `SpeakerRevision`. Orion read `message.turns` from that message; the
 *    field is `message.revisions`, so every correction was dropped and both
 *    interjections stayed unattributed for the rest of the meeting — while
 *    displaying as a speaker literally named "PENDING".
 *  - Once the revision does land, its label is "B". Decoded by alphabet
 *    position that is "Speaker 2" by luck rather than by right: the same
 *    session could have clustered the second voice as "D" and displayed
 *    Speaker 4. The numbering here comes from who spoke first.
 *
 * The word lists are trimmed to their first two entries, which is all the
 * reconciliation reads from a turn whose words agree. The revision's words are
 * complete, because those are the ones that matter.
 */

import { describe, it, expect } from "vitest";
import { CanonicalSpeakers } from "@/lib/canonical-speakers";
import {
  applySpeakerRevision,
  applyTurn,
  finalTurns,
  type LiveTurn,
  type SessionContext,
} from "@/lib/live-turns";

const SESSION: SessionContext = { epoch: 1, offsetSeconds: 0 };

/** Captured from the wire, `type: "Turn"` with `end_of_turn: true`. */
const CAPTURED: Record<string, unknown>[] = [
  {
    type: "Turn", turn_order: 0, end_of_turn: true, speaker_label: "A",
    transcript: "We need to finish authentication before the end of the week, then update the dashboard so the new metrics actually render, and after that deploy to staging and review the billing flow",
    words: [
      { text: "We", start: 113, end: 193, speaker: "A" },
      { text: "need", start: 210, end: 436, speaker: "A" },
    ],
  },
  {
    type: "Turn", turn_order: 1, end_of_turn: true, speaker_label: "A",
    transcript: "with the finance team.",
    words: [{ text: "with", start: 12290, end: 12450, speaker: "A" }],
  },
  {
    type: "Turn", turn_order: 2, end_of_turn: true, speaker_label: "A",
    transcript: "There are still 3 open questions about the retry policy and I would like to close those out first.",
    words: [{ text: "There", start: 13010, end: 13200, speaker: "A" }],
  },
  {
    // The provider has heard a different voice and has not yet clustered it.
    type: "Turn", turn_order: 3, end_of_turn: true, speaker_label: "PENDING",
    transcript: "Exactly.",
    words: [{ text: "Exactly.", start: 18467, end: 18914, speaker: "PENDING" }],
  },
  {
    type: "Turn", turn_order: 4, end_of_turn: true, speaker_label: "A",
    transcript: "So once that is done, we can move on to the migration and start monitoring production traffic closely.",
    words: [{ text: "So", start: 19030, end: 19200, speaker: "A" }],
  },
  {
    type: "Turn", turn_order: 5, end_of_turn: true, speaker_label: "PENDING",
    transcript: "Yes, I agree.",
    words: [{ text: "Yes,", start: 26146, end: 26344, speaker: "PENDING" }],
  },
  {
    type: "Turn", turn_order: 6, end_of_turn: true, speaker_label: "A",
    transcript: "Good, then I will write it up and send it round this afternoon.",
    words: [{ text: "Good,", start: 27430, end: 27700, speaker: "A" }],
  },
];

/** The single `SpeakerRevision` the session sent, verbatim. */
const REVISION = {
  type: "SpeakerRevision",
  revisions: [
    {
      turn_order: 3,
      speaker_label: "B",
      words: [{ start: 18467, end: 18914, text: "Exactly.", speaker: "B", word_is_final: true }],
    },
    {
      turn_order: 5,
      speaker_label: "B",
      words: [
        { start: 26146, end: 26344, text: "Yes,", speaker: "B", word_is_final: true },
        { start: 26971, end: 26988, text: "I", speaker: "B", word_is_final: true },
        { start: 27087, end: 27317, text: "agree.", speaker: "B", word_is_final: true },
      ],
    },
  ],
};

function replay(messages: Record<string, unknown>[]): LiveTurn[] {
  const speakers = new CanonicalSpeakers();
  let turns: LiveTurn[] = [];
  for (const message of messages) {
    turns =
      message.type === "SpeakerRevision"
        ? applySpeakerRevision(turns, message, SESSION, speakers)
        : applyTurn(turns, message, SESSION, speakers);
  }
  return finalTurns(turns);
}

describe("a captured streaming session", () => {
  it("ends up attributing both interjections to the second voice", () => {
    const turns = replay([...CAPTURED, REVISION]);

    expect(turns.map((t) => [t.speaker, t.text.slice(0, 22)])).toEqual([
      ["Speaker 1", "We need to finish auth"],
      ["Speaker 1", "with the finance team."],
      ["Speaker 1", "There are still 3 open"],
      ["Speaker 2", "Exactly."],
      ["Speaker 1", "So once that is done, "],
      ["Speaker 2", "Yes, I agree."],
      ["Speaker 1", "Good, then I will writ"],
    ]);
  });

  it("shows exactly two people, and neither of them is called PENDING", () => {
    const turns = replay([...CAPTURED, REVISION]);

    expect(new Set(turns.map((t) => t.speaker))).toEqual(
      new Set(["Speaker 1", "Speaker 2"]),
    );
    expect(turns.every((t) => t.speakerStatus === "attributed")).toBe(true);
  });

  it("says it does not know, rather than guessing, before the correction lands", () => {
    // This is the honest intermediate state, and it is what the user sees for
    // the second or so before the revision arrives. "Identifying speaker" is a
    // true statement; "PENDING" was not, and neither is filing the line under
    // whoever was talking around it.
    const turns = replay(CAPTURED);

    expect(turns[3]).toMatchObject({
      text: "Exactly.", speaker: "Unknown speaker", speakerStatus: "unknown",
    });
    // And the unattributed turn has not stolen a number from anybody.
    expect(turns[4].speaker).toBe("Speaker 1");
  });

  it("corrects in place rather than adding a second copy", () => {
    const before = replay(CAPTURED);
    const after = replay([...CAPTURED, REVISION]);

    expect(after).toHaveLength(before.length);
    expect(after.filter((t) => t.text === "Exactly.")).toHaveLength(1);
  });

  it("keeps the provider's own timings for the corrected turns", () => {
    const turns = replay([...CAPTURED, REVISION]);

    // 18.34 and 26.02 in the source audio; the provider heard them at 18.47
    // and 26.15. Both are the provider's numbers, not a timer in the browser.
    expect(turns[3].at).toBeCloseTo(18.47, 2);
    expect(turns[5].at).toBeCloseTo(26.15, 2);
  });

  it("keeps the raw labels so the mapping can be checked afterwards", () => {
    const turns = replay([...CAPTURED, REVISION]);

    // The diagnosis this enables: the provider said B and Orion drew
    // Speaker 2 because B was the second voice heard -- not because B is the
    // second letter.
    expect(turns[3]).toMatchObject({ speakerRaw: "B", speakerKey: "spk_2" });
    expect(turns[0]).toMatchObject({ speakerRaw: "A", speakerKey: "spk_1" });
  });

  it("would have shown Speaker 4 under the old mapping", () => {
    // Guarding the actual reported symptom rather than only its cause. Replay
    // the same session with the provider's letters shifted -- the same two
    // voices, clustered as D and F, which is a thing the provider does.
    const shifted = CAPTURED.map((m) => ({
      ...m,
      speaker_label: m.speaker_label === "A" ? "D" : m.speaker_label,
      words: (m.words as { speaker?: string }[]).map((w) => ({
        ...w,
        speaker: w.speaker === "A" ? "D" : w.speaker,
      })),
    }));
    const shiftedRevision = {
      ...REVISION,
      revisions: REVISION.revisions.map((r) => ({
        ...r,
        speaker_label: "F",
        words: r.words.map((w) => ({ ...w, speaker: "F" })),
      })),
    };

    const turns = replay([...shifted, shiftedRevision]);

    // Not Speaker 4 and Speaker 6.
    expect(new Set(turns.map((t) => t.speaker))).toEqual(
      new Set(["Speaker 1", "Speaker 2"]),
    );
    expect(turns[3]).toMatchObject({ speaker: "Speaker 2", speakerRaw: "F" });
  });
});
