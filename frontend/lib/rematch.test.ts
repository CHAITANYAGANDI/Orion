import { describe, expect, it } from "vitest";

import { rematchMessage } from "@/lib/rematch";
import type { SpeakerRematchResult } from "@/lib/types";

function result(over: Partial<SpeakerRematchResult> = {}): SpeakerRematchResult {
  return { matched: 0, names: [], considered: 0, unavailable: null, ...over };
}

/**
 * The sentence after a rematch.
 *
 * A rematch quietly changes names in a transcript the user may not be looking
 * at, so this toast is often the only evidence it did anything. Three outcomes
 * have to stay apart, and two of them look identical if you are not careful:
 * "we looked and nobody matched" and "we could not look" both end in nothing
 * having changed, and only one of them has something the user can do about it.
 */
describe("what a rematch reports", () => {
  it("counts the speakers renamed, not the turns rewritten", () => {
    // Eleven turns may have moved. One person was identified.
    expect(rematchMessage(result({ matched: 1, names: ["Sarah"] }))).toMatchObject({
      text: "1 speaker rematched.",
      detail: "Sarah",
    });
  });

  it("pluralises honestly", () => {
    expect(rematchMessage(result({ matched: 2, names: ["Sarah", "Tom"] }))).toMatchObject({
      text: "2 speakers rematched.",
      detail: "Sarah, Tom",
    });
  });

  it("says who, because a bare count invites a re-read of the whole transcript", () => {
    expect(rematchMessage(result({ matched: 3, names: ["Sarah", "Tom", "Priya"] })).detail)
      .toBe("Sarah, Tom, Priya");
  });

  it("reports finding nobody as a result rather than a failure", () => {
    const message = rematchMessage(result({ considered: 4 }));

    // The common case, and it is not an error: four speakers were compared
    // against every known voice and none cleared the bar. A red toast here
    // would train people to stop pressing a button that is working correctly.
    expect(message.tone).toBe("success");
    expect(message.text).toBe("No new speaker matches found.");
    expect(message.detail).toBeUndefined();
  });

  it("keeps 'could not look' separate from 'looked and found nobody'", () => {
    const message = rematchMessage(
      result({
        unavailable: "Turn on speaker matching in Settings to identify speakers automatically.",
      }),
    );

    // Different sentence, different tone, and it names the thing to do. Told
    // "no matches found" instead, somebody with the feature switched off would
    // press this for ever.
    expect(message.tone).toBe("info");
    expect(message.text).toContain("Settings");
    expect(message.text).not.toContain("No new speaker matches");
  });

  it("prefers the unavailable reason over the count, whatever the count says", () => {
    // Defensive: a server that sent both would otherwise be reported as a
    // success over data it never actually applied.
    expect(
      rematchMessage(result({ matched: 2, names: ["Sarah"], unavailable: "Not configured." })),
    ).toMatchObject({ tone: "info", text: "Not configured." });
  });

  it("never renders a confidence percentage", () => {
    // The matcher thresholds on cosine similarity, which is the right quantity
    // to threshold on and is not a calibrated probability. There is no field
    // carrying one and nowhere in these strings to put one — asserted so that a
    // later "helpful" addition has to delete this test on purpose.
    const messages = [
      rematchMessage(result({ matched: 1, names: ["Sarah"] })),
      rematchMessage(result({ considered: 2 })),
      rematchMessage(result({ unavailable: "Not configured." })),
    ];

    for (const message of messages) {
      expect(`${message.text} ${message.detail ?? ""}`).not.toMatch(/%|confiden|certain|likely/i);
    }
  });
});
