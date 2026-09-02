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

/**
 * The last layer of the A/B/A/B round trip.
 *
 * The server half is `SpeakerOwnershipRoundTripTest`: provider payload ->
 * callback JSON -> rows -> GET transcript. This is what the browser then does
 * with the response, and it is the last place two speakers could still become
 * one — by grouping on the name instead of the key.
 *
 * The segments below are shaped exactly as `SegmentDto` serialises them, down
 * to `speakerRaw` being absent: the client is never sent the provider's cluster
 * id, so `speakerKey` has to be sufficient on its own.
 */
describe("A/B/A/B survives rendering", () => {
  /** What `GET /meetings/:id/transcript` returns for the round-trip fixture. */
  const fromApi = [
    { id: "s1", start: 0.0, end: 3.0, speaker: "Charles", text: "Hi Michael, how are you?", speakerKey: "spk_1", speakerStatus: "attributed" },
    { id: "s2", start: 3.2, end: 6.0, speaker: "Michael", text: "I'm good, Charles.", speakerKey: "spk_2", speakerStatus: "attributed" },
    { id: "s3", start: 6.2, end: 10.0, speaker: "Charles", text: "Did you finish the deployment?", speakerKey: "spk_1", speakerStatus: "attributed" },
    { id: "s4", start: 10.2, end: 11.0, speaker: "Michael", text: "Yes.", speakerKey: "spk_2", speakerStatus: "attributed" },
  ] as unknown as Parameters<typeof groupIntoTurns>[0];

  it("renders four alternating turns, never one", () => {
    const turns = groupIntoTurns(fromApi);

    expect(turns).toHaveLength(4);
    expect(turns.map((t) => t.speakerKey)).toEqual(["spk_1", "spk_2", "spk_1", "spk_2"]);
    expect(turns.map((t) => t.speaker)).toEqual(["Charles", "Michael", "Charles", "Michael"]);
  });

  it("groups on the key, so inferred names cannot merge two speakers", () => {
    // The reported failure, forced: a naming pass that put one name on both
    // voices. Refused upstream, and refused again here — different keys never
    // merge however the names read.
    const collided = fromApi.map((s) => ({ ...s, speaker: "Michael" })) as typeof fromApi;

    expect(groupIntoTurns(collided)).toHaveLength(4);
    expect(groupIntoTurns(collided).map((t) => t.speakerKey))
      .toEqual(["spk_1", "spk_2", "spk_1", "spk_2"]);
  });

  it("still merges consecutive utterances by one speaker", () => {
    // The other direction: grouping has to keep doing its job. One person
    // talking across three segments is one paragraph, not three rows.
    const runOn = [fromApi[0], { ...fromApi[0], id: "s1b" }, fromApi[1]] as typeof fromApi;

    expect(groupIntoTurns(runOn).map((t) => t.segments.length)).toEqual([2, 1]);
  });
});

/**
 * Coalescing after an acoustic correction.
 *
 * When `rediarize` re-owns a mislabelled fragment, the transcript is left with
 * two adjacent segments carrying the same canonical speaker and different
 * provider labels:
 *
 *     raw C  01:17  "That's--"        -> spk_1   (corrected)
 *     raw A  01:19  "so I guess..."   -> spk_1
 *
 * They should read as one turn. The question is whether grouping already does
 * that, and it does -- `sameVoice` compares `speakerKey` and nothing else, so a
 * corrected fragment merges with its continuation without any further work.
 *
 * The individual segments survive underneath: their timestamps, their text and
 * their provider labels are all still there, which is what keeps a correction
 * reversible and a complaint traceable.
 */
describe("corrected fragments coalesce for display", () => {
  const corrected = [
    { id: "s1", start: 73.0, end: 73.4, speaker: "Speaker 1", text: "That's-", speakerKey: "spk_1", speakerStatus: "attributed" },
    { id: "s2", start: 79.0, end: 95.0, speaker: "Speaker 1", text: "so I guess the next-", speakerKey: "spk_1", speakerStatus: "attributed" },
    { id: "s3", start: 95.5, end: 120.0, speaker: "Speaker 3", text: "So we have the Jira stuff", speakerKey: "spk_3", speakerStatus: "attributed" },
  ] as unknown as Parameters<typeof groupIntoTurns>[0];

  it("reads as one turn once the fragment has been re-owned", () => {
    const turns = groupIntoTurns(corrected);

    expect(turns).toHaveLength(2);
    expect(turns[0].speakerKey).toBe("spk_1");
    expect(turns[0].segments).toHaveLength(2);
    expect(turns[1].speakerKey).toBe("spk_3");
  });

  it("keeps every underlying segment, timestamp and text", () => {
    const [first] = groupIntoTurns(corrected);

    expect(first.start).toBe(73.0);
    expect(first.segments.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(first.segments.map((s) => s.text)).toEqual(["That's-", "so I guess the next-"]);
  });

  it("does not coalesce before the correction", () => {
    // The same three segments as diarization first produced them. Two visible
    // turns where there should be one, which is the reported symptom.
    const uncorrected = corrected.map((s, i) =>
      i === 0 ? { ...s, speaker: "Speaker 3", speakerKey: "spk_3" } : s,
    ) as typeof corrected;

    expect(groupIntoTurns(uncorrected)).toHaveLength(3);
  });
});
