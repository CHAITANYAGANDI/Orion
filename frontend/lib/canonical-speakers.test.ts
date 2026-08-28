/**
 * Meeting-local speaker numbering, and the colour that follows a speaker around.
 *
 * The bug these pin: AssemblyAI clusters voices and names the clusters "A",
 * "B", "C"… and Orion decoded the letter by its position in the alphabet, so
 * a two-person meeting whose voices clustered as A and D displayed **Speaker 1
 * and Speaker 4** — with no Speaker 2 or 3 anywhere, which reads as two people
 * missing from the room.
 *
 * Mirrors `ai-service/tests/test_diarization.py`. The two implementations exist
 * because the live transcript cannot wait for a server round trip to know what
 * to call somebody, and matching cases on both sides is what keeps them from
 * drifting apart.
 */

import { describe, it, expect } from "vitest";
import {
  CanonicalSpeakers,
  UNKNOWN_SPEAKER,
  isGenericCluster,
  rawToken,
} from "@/lib/canonical-speakers";
import { SPEAKER_COLORS, speakerColor, speakerHex, speakerIdentity } from "@/lib/speakers";

describe("numbering", () => {
  it("numbers by first appearance, not by the letter", () => {
    const speakers = new CanonicalSpeakers();

    expect(speakers.resolve("D").label).toBe("Speaker 1");
    expect(speakers.resolve("A").label).toBe("Speaker 2");
    expect(speakers.resolve("F").label).toBe("Speaker 3");
  });

  it("gives a speaker the same number every time they come back", () => {
    const speakers = new CanonicalSpeakers();
    const order = ["A", "D", "A", "D", "F", "A"];

    expect(order.map((raw) => speakers.resolve(raw).label)).toEqual([
      "Speaker 1", "Speaker 2", "Speaker 1", "Speaker 2", "Speaker 3", "Speaker 1",
    ]);
  });

  it("is deterministic: the same order in, the same numbers out", () => {
    const run = () => {
      const speakers = new CanonicalSpeakers();
      return ["Q", "C", "Q", "M"].map((raw) => speakers.resolve(raw).key);
    };

    expect(run()).toEqual(run());
    expect(run()).toEqual(["spk_1", "spk_2", "spk_1", "spk_3"]);
  });

  it("treats a letter's case as spelling, not identity", () => {
    const speakers = new CanonicalSpeakers();

    expect(speakers.resolve("a").label).toBe("Speaker 1");
    expect(speakers.resolve(" A ").label).toBe("Speaker 1");
    expect(speakers.count).toBe(1);
  });

  it("handles a provider that numbers speakers instead of lettering them", () => {
    const speakers = new CanonicalSpeakers();

    expect(speakers.resolve(3).label).toBe("Speaker 1");
    expect(speakers.resolve(0).label).toBe("Speaker 2");
  });

  it("keeps a real name rather than replacing it with a number", () => {
    // Speaker identification returns names. A name beats anything Orion
    // could invent, and it still gets a key so the colour behaves.
    const speakers = new CanonicalSpeakers();
    const cindy = speakers.resolve("Cindy");

    expect(cindy.label).toBe("Cindy");
    expect(cindy.key).toBe("spk_1");
    // The ordinal is spent, so the next unnamed voice does not collide with her.
    expect(speakers.resolve("B").label).toBe("Speaker 2");
  });
});

describe("refusing to guess", () => {
  it.each([null, undefined, "", "  ", "UNKNOWN", "unk", "?", {}, [], NaN, true])(
    "will not turn %s into a speaker",
    (value) => {
      const identity = new CanonicalSpeakers().resolve(value);
      expect(identity.label).toBe(UNKNOWN_SPEAKER);
      expect(identity.status).toBe("unknown");
      expect(identity.key).toBeNull();
    },
  );

  it("treats PENDING as a placeholder rather than a name", () => {
    // Observed on the wire and absent from the docs: the live stream labels a
    // turn PENDING until clustering catches up. It used to fall through to the
    // "must be a real name" branch, so the transcript showed turns spoken by
    // somebody called PENDING — and marked them attributed, so it read as an
    // answer rather than as a placeholder.
    expect(rawToken("PENDING")).toBeNull();
    expect(new CanonicalSpeakers().resolve("PENDING").status).toBe("unknown");
  });

  it("does not spend a number on a voice it could not identify", () => {
    const speakers = new CanonicalSpeakers();
    speakers.resolve("PENDING");
    speakers.resolve(null);

    // Otherwise one unlabelled turn early on shifts everybody after it by one.
    expect(speakers.resolve("A").label).toBe("Speaker 1");
  });

  it("knows a cluster id from a name", () => {
    expect(isGenericCluster("A")).toBe(true);
    expect(isGenericCluster("12")).toBe(true);
    expect(isGenericCluster("Cindy")).toBe(false);
  });
});

describe("colour", () => {
  it("follows the speaker through a rename", () => {
    // The bug this closes: colour was hashed from the display name, so renaming
    // Speaker 2 to Sarah changed her colour at the exact moment she acquired a
    // name — and the coloured bands under the scrubber stopped agreeing with
    // the avatars beside the transcript.
    expect(speakerColor("Sarah", "spk_2")).toBe(speakerColor("Speaker 2", "spk_2"));
    expect(speakerHex("Sarah", "spk_2")).toBe(speakerHex("Speaker 2", "spk_2"));
  });

  it("gives two different speakers a chance to differ", () => {
    expect(speakerColor("Speaker 1", "spk_1")).not.toBe(speakerColor("Speaker 2", "spk_2"));
  });

  it("falls back to the name for transcripts recorded before keys existed", () => {
    // Those rows have no key, and must go on looking exactly as they did.
    expect(speakerIdentity("Speaker 2", null)).toBe("Speaker 2");
    expect(speakerIdentity("Speaker 2", "   ")).toBe("Speaker 2");
    expect(speakerColor("Speaker 2")).toBe(speakerColor("Speaker 2", null));
  });

  it("always picks a real colour", () => {
    for (const key of ["spk_1", "spk_2", "spk_9", "spk_40"]) {
      expect(SPEAKER_COLORS).toContain(speakerColor("whoever", key));
    }
  });
});
