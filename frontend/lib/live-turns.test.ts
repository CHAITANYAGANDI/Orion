/**
 * The part of live transcription with the interesting failure modes.
 *
 * Reconciliation, revision and reconnection, tested as pure functions over
 * arrays — no websocket, no fake timers, no jsdom. Everything below is a thing
 * the old browser-speech preview got wrong or could not do at all, and each one
 * shows up on screen rather than in a log.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CanonicalSpeakers } from "@/lib/canonical-speakers";
import {
  UNKNOWN_SPEAKER,
  applySpeakerRevision as revise,
  applyTurn as fold,
  finalTurns,
  joinWords,
  pendingTurn,
  turnStartSeconds,
  type LiveTurn,
  type SessionContext,
} from "@/lib/live-turns";

const FIRST: SessionContext = { epoch: 1, offsetSeconds: 0 };

/**
 * The session's speaker registry, reset per test.
 *
 * It is a parameter rather than module state because the numbering has to be
 * meeting-local: two tests sharing one registry would number the second one
 * from wherever the first left off, which is precisely the bug being guarded
 * against, arriving through the test harness.
 */
let speakers: CanonicalSpeakers;
beforeEach(() => {
  speakers = new CanonicalSpeakers();
});

function applyTurn(
  turns: LiveTurn[],
  message: Parameters<typeof fold>[1],
  session: SessionContext,
) {
  return fold(turns, message, session, speakers);
}

function applySpeakerRevision(
  turns: LiveTurn[],
  message: Parameters<typeof revise>[1],
  session: SessionContext,
) {
  return revise(turns, message, session, speakers);
}

function turn(order: number, transcript: string, extra: Record<string, unknown> = {}) {
  return { type: "Turn", turn_order: order, transcript, ...extra };
}

/** One word as the provider sends it: milliseconds, and a speaker each. */
function w(text: string, speaker: string | null, start: number) {
  return { text, start, end: start + 400, speaker };
}

/* -------------------------------------------------------------------------- */
/* One evolving turn, never three lines about one sentence.                   */
/* -------------------------------------------------------------------------- */
describe("partials", () => {
  it("replaces the turn it is revising rather than appending to it", () => {
    let turns: LiveTurn[] = [];
    turns = applyTurn(turns, turn(7, "We need to deploy"), FIRST);
    turns = applyTurn(turns, turn(7, "We need to deploy Friday"), FIRST);
    turns = applyTurn(turns, turn(7, "We need to deploy Friday.", { end_of_turn: true }), FIRST);

    // Appended, this is three lines about one sentence and the meeting is
    // unreadable within a minute.
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("We need to deploy Friday.");
    expect(turns[0].final).toBe(true);
  });

  it("keeps different turns apart", () => {
    let turns: LiveTurn[] = [];
    turns = applyTurn(turns, turn(1, "Morning all.", { end_of_turn: true }), FIRST);
    turns = applyTurn(turns, turn(2, "Morning.", { end_of_turn: true }), FIRST);

    expect(turns.map((t) => t.text)).toEqual(["Morning all.", "Morning."]);
  });

  it("returns the same array when a partial repeats what it already had", () => {
    // Not a micro-optimisation: these arrive several times a second, and a new
    // array each time re-renders the whole transcript.
    const first = applyTurn([], turn(1, "Hello"), FIRST);
    const again = applyTurn(first, turn(1, "Hello"), FIRST);

    expect(again).toBe(first);
  });

  it("ignores a late partial for a turn that has already settled", () => {
    let turns = applyTurn([], turn(1, "Final words.", { end_of_turn: true }), FIRST);
    turns = applyTurn(turns, turn(1, "Final wor"), FIRST);

    expect(turns[0].text).toBe("Final words.");
    expect(turns[0].final).toBe(true);
  });

  it("does not blank a line when an empty partial arrives", () => {
    let turns = applyTurn([], turn(1, "Something"), FIRST);
    turns = applyTurn(turns, turn(1, "   "), FIRST);

    expect(turns[0].text).toBe("Something");
  });

  it("ignores a message with no turn order to key on", () => {
    expect(applyTurn([], { type: "Turn", transcript: "orphan" }, FIRST)).toHaveLength(0);
  });

  it("separates the settled transcript from the words still being said", () => {
    let turns = applyTurn([], turn(1, "Settled.", { end_of_turn: true }), FIRST);
    turns = applyTurn(turns, turn(2, "still going"), FIRST);

    expect(finalTurns(turns).map((t) => t.text)).toEqual(["Settled."]);
    expect(pendingTurn(turns)?.text).toBe("still going");
  });
});

/* -------------------------------------------------------------------------- */
/* Timestamps from the provider, not from a timer in this tab.                */
/* -------------------------------------------------------------------------- */
describe("timestamps", () => {
  it("uses the provider's audio position", () => {
    const turns = applyTurn([], turn(1, "Validated Heath's quiet determination", {
      audio_start: 4000,
    }), FIRST);

    // The regression case. The browser preview stamped this line 0:10 because
    // that is when recognition returned; it was said at 0:04.
    expect(turns[0].at).toBe(4);
  });

  it("falls back to the first word's own start", () => {
    const turns = applyTurn([], turn(1, "hello there", {
      words: [{ text: "hello", start: 20500 }, { text: "there", start: 21000 }],
    }), FIRST);

    expect(turns[0].at).toBe(20.5);
  });

  it("keeps the time a turn began while it is still being revised", () => {
    let turns = applyTurn([], turn(1, "We need", { audio_start: 4000 }), FIRST);
    turns = applyTurn(turns, turn(1, "We need to deploy", { audio_start: 9000 }), FIRST);

    // A turn that slides forward as it grows is a line whose timestamp drifts
    // away from the audio while somebody watches it.
    expect(turns[0].at).toBe(4);
  });

  it("survives a message carrying no usable position at all", () => {
    const later: SessionContext = { epoch: 2, offsetSeconds: 30 };
    const turns = applyTurn([], turn(1, "no timing here"), later);

    // The reconnect point, not zero: a line claiming 0:00 is wrong about a
    // part of the meeting somebody can scroll back to and check.
    expect(turns[0].at).toBe(30);
  });

  it("computes the start from the session offset", () => {
    const resumed: SessionContext = { epoch: 3, offsetSeconds: 120 };
    expect(turnStartSeconds({ audio_start: 5000 }, resumed)).toBe(125);
  });
});

/* -------------------------------------------------------------------------- */
/* Reconnection.                                                              */
/* -------------------------------------------------------------------------- */
describe("reconnecting", () => {
  const SECOND: SessionContext = { epoch: 2, offsetSeconds: 62 };

  it("does not overwrite the meeting with the new session's first turn", () => {
    // Both sessions count turns from zero. Keyed on turn order alone, the
    // first thing said after a reconnect replaces the first thing said at all.
    let turns = applyTurn([], turn(0, "Before the drop.", { end_of_turn: true }), FIRST);
    turns = applyTurn(turns, turn(0, "After the drop.", { end_of_turn: true, audio_start: 1000 }), SECOND);

    expect(turns).toHaveLength(2);
    expect(turns.map((t) => t.text)).toEqual(["Before the drop.", "After the drop."]);
  });

  it("places the reconnected session on the recording's timeline", () => {
    const turns = applyTurn([], turn(0, "After the drop.", { audio_start: 1000 }), SECOND);

    // The provider's clock restarted; the recording's did not.
    expect(turns[0].at).toBe(63);
  });

  it("creates no duplicate when the same words arrive again after a reconnect", () => {
    let turns = applyTurn([], turn(4, "Deploy on Friday.", { end_of_turn: true, audio_start: 5000 }), FIRST);
    // A retransmission inside the same session is an upsert, not a second line.
    turns = applyTurn(turns, turn(4, "Deploy on Friday.", { end_of_turn: true, audio_start: 5000 }), FIRST);

    expect(turns).toHaveLength(1);
  });

  it("orders by when things were said, not by when they arrived", () => {
    let turns = applyTurn([], turn(0, "Later.", { audio_start: 0, end_of_turn: true }), SECOND);
    turns = applyTurn(turns, turn(9, "Earlier.", { audio_start: 30000, end_of_turn: true }), FIRST);

    expect(turns.map((t) => t.text)).toEqual(["Earlier.", "Later."]);
  });
});

/* -------------------------------------------------------------------------- */
/* Speakers.                                                                  */
/* -------------------------------------------------------------------------- */
describe("speaker numbering", () => {
  it("numbers by who spoke first, not by where the letter sits in the alphabet", () => {
    // The reported bug. "D" was rendered `charCodeAt(0) - 64` = Speaker 4, so a
    // two-person meeting showed Speaker 1 and Speaker 4 with nobody in between —
    // which reads as two people missing from the room.
    let turns = applyTurn([], turn(1, "I'll start.", {
      end_of_turn: true, speaker_label: "D", audio_start: 0,
    }), FIRST);
    turns = applyTurn(turns, turn(2, "Go ahead.", {
      end_of_turn: true, speaker_label: "A", audio_start: 5000,
    }), FIRST);

    expect(turns.map((t) => t.speaker)).toEqual(["Speaker 1", "Speaker 2"]);
  });

  it("gives non-contiguous provider labels contiguous numbers", () => {
    let turns: LiveTurn[] = [];
    ["A", "A", "D", "A", "F"].forEach((label, i) => {
      turns = applyTurn(turns, turn(i, "line " + i, {
        end_of_turn: true, speaker_label: label, audio_start: i * 1000,
      }), FIRST);
    });

    expect(turns.map((t) => t.speaker)).toEqual([
      "Speaker 1", "Speaker 1", "Speaker 2", "Speaker 1", "Speaker 3",
    ]);
  });

  it("keeps a speaker's number when they speak again", () => {
    let turns: LiveTurn[] = [];
    ["A", "D", "A", "D"].forEach((label, i) => {
      turns = applyTurn(turns, turn(i, "line " + i, {
        end_of_turn: true, speaker_label: label, audio_start: i * 1000,
      }), FIRST);
    });

    expect(turns.map((t) => t.speaker)).toEqual([
      "Speaker 1", "Speaker 2", "Speaker 1", "Speaker 2",
    ]);
  });

  it("keeps the provider's cluster id without showing it", () => {
    const turns = applyTurn([], turn(1, "Morning.", {
      end_of_turn: true, speaker_label: "D", audio_start: 20000,
    }), FIRST);

    expect(turns[0]).toMatchObject({
      speaker: "Speaker 1", speakerKey: "spk_1", speakerRaw: "D", at: 20,
    });
  });

  it("survives a reconnect without renaming everybody", () => {
    // A new session restarts the provider's letters from "A". Renumbering from
    // there would rename the person somebody has already worked out is
    // Speaker 2, halfway through the meeting.
    let turns = applyTurn([], turn(0, "First voice.", {
      end_of_turn: true, speaker_label: "D", audio_start: 0,
    }), FIRST);
    turns = applyTurn(turns, turn(0, "Same voice, new socket.", {
      end_of_turn: true, speaker_label: "D", audio_start: 1000,
    }), { epoch: 2, offsetSeconds: 62 });

    expect(turns.map((t) => t.speaker)).toEqual(["Speaker 1", "Speaker 1"]);
  });

  it("keeps a real name rather than numbering it", () => {
    const turns = applyTurn([], turn(1, "Morning.", {
      end_of_turn: true, speaker_label: "Chaitanya",
    }), FIRST);

    expect(turns[0].speaker).toBe("Chaitanya");
  });

  it("takes the speaker from the words when the turn does not carry one", () => {
    const turns = applyTurn([], turn(1, "over here", {
      words: [{ text: "over" }, { text: "here", speaker: "B" }],
    }), FIRST);

    // Speaker 1 rather than Speaker 2: B is the first voice this meeting has
    // heard, whatever letter the provider filed it under.
    expect(turns[0].speaker).toBe("Speaker 1");
  });

  it.each([null, undefined, "", "UNKNOWN", "unknown", "?", {}, NaN])(
    "refuses to invent an attribution for %s",
    (label) => {
      // Filing an unattributed turn under the first speaker puts a quotation
      // beside a name that may never have said it, and during a live meeting
      // that name is read and acted on.
      const turns = applyTurn([], turn(1, "mm hm", { speaker_label: label }), FIRST);
      expect(turns[0].speaker).toBe(UNKNOWN_SPEAKER);
      expect(turns[0].speakerStatus).toBe("unknown");
      expect(turns[0].speakerKey).toBeNull();
    },
  );

  it("treats PENDING as the provider declining to answer, not as a name", () => {
    // Observed on the wire and absent from the docs. It used to fall through to
    // the "must be a real name" branch, so the transcript showed turns spoken
    // by somebody called PENDING — and marked them attributed, so it looked
    // like an answer rather than a placeholder.
    const turns = applyTurn([], turn(3, "Exactly.", {
      end_of_turn: true, speaker_label: "PENDING",
    }), FIRST);

    expect(turns[0].speaker).toBe(UNKNOWN_SPEAKER);
    expect(turns[0].speakerStatus).toBe("unknown");
  });

  it("does not spend a speaker number on an unattributed turn", () => {
    let turns = applyTurn([], turn(1, "Exactly.", {
      end_of_turn: true, speaker_label: "PENDING", audio_start: 0,
    }), FIRST);
    turns = applyTurn(turns, turn(2, "Right then.", {
      end_of_turn: true, speaker_label: "A", audio_start: 1000,
    }), FIRST);

    // Otherwise one unlabelled turn early on shifts every later speaker by one.
    expect(turns[1].speaker).toBe("Speaker 1");
  });
});

/* -------------------------------------------------------------------------- */
/* A speaker change inside one provider turn.                                 */
/* -------------------------------------------------------------------------- */
describe("mid-turn interjections", () => {
  it("splits one turn into three when the words say three people spoke", () => {
    // The reported bug on the live path. The turn carried a single speaker, so
    // "Exactly." was published under whoever was talking around it.
    const turns = applyTurn([], turn(1, "We should ship Friday. Exactly. And then deploy.", {
      end_of_turn: true,
      speaker_label: "A",
      words: [
        w("We", "A", 0), w("should", "A", 400), w("ship", "A", 800), w("Friday.", "A", 1200),
        w("Exactly.", "B", 1600),
        w("And", "A", 2000), w("then", "A", 2400), w("deploy.", "A", 2800),
      ],
    }), FIRST);

    expect(turns.map((t) => [t.speaker, t.text])).toEqual([
      ["Speaker 1", "We should ship Friday."],
      ["Speaker 2", "Exactly."],
      ["Speaker 1", "And then deploy."],
    ]);
  });

  it("never merges a turn away for being short", () => {
    // "Merge anything under three words into the neighbour" would reproduce the
    // reported bug exactly, while looking like a tidy-up.
    for (const reply of ["Yes.", "No.", "Right.", "Why?", "Okay.", "Me too."]) {
      speakers = new CanonicalSpeakers();
      const turns = applyTurn([], turn(1, "So that is agreed. Moving on.", {
        end_of_turn: true,
        speaker_label: "A",
        words: [
          w("So", "A", 0), w("that's", "A", 400), w("agreed.", "A", 800),
          w(reply, "B", 1200),
          w("Moving", "A", 1600), w("on.", "A", 2000),
        ],
      }), FIRST);

      expect(turns.map((t) => t.text)).toEqual(["So that's agreed.", reply, "Moving on."]);
    }
  });

  it("keeps the provider's own text when the words agree", () => {
    // Rebuilt text is subtly worse than the provider's; only a split turn gets
    // reassembled.
    const turns = applyTurn([], turn(1, "There are 3 open questions.", {
      end_of_turn: true,
      speaker_label: "A",
      words: [w("There", "A", 0), w("are", "A", 400), w("three", "A", 800)],
    }), FIRST);

    expect(turns.map((t) => t.text)).toEqual(["There are 3 open questions."]);
  });

  it("times each fragment from its own words", () => {
    // Section 26: clicking a turn has to land on it in the audio.
    const turns = applyTurn([], turn(1, "Long preamble. Exactly. Carrying on.", {
      end_of_turn: true,
      words: [
        w("Long", "A", 0), w("preamble.", "A", 500),
        w("Exactly.", "B", 5000),
        w("Carrying", "A", 9000), w("on.", "A", 9400),
      ],
    }), FIRST);

    expect(turns.map((t) => t.at)).toEqual([0, 5, 9]);
  });

  it("does not start an island for a word the provider left unattributed", () => {
    // Gaps mid-turn are common; honouring each one would shred a sentence into
    // alternating known and unknown fragments.
    const turns = applyTurn([], turn(1, "We should ship.", {
      end_of_turn: true,
      words: [w("We", "A", 0), w("should", null, 400), w("ship.", "A", 800)],
    }), FIRST);

    expect(turns.map((t) => [t.speaker, t.text])).toEqual([["Speaker 1", "We should ship."]]);
  });

  it("splits without mangling punctuation", () => {
    const turns = applyTurn([], turn(1, "We should ship Friday, yes, if QA passes.", {
      end_of_turn: true,
      words: [
        w("We", "A", 0), w("should", "A", 400), w("ship", "A", 800), w("Friday,", "A", 1200),
        w("yes,", "B", 1600),
        w("if", "A", 2000), w("QA", "A", 2400), w("passes.", "A", 2800),
      ],
    }), FIRST);

    expect(turns.map((t) => t.text)).toEqual([
      "We should ship Friday,", "Yes,", "If QA passes.",
    ]);
    for (const t of turns) expect(t.text).not.toMatch(/\s[,.]/);
  });

  it("does not capitalise a brand into nonsense", () => {
    expect(joinWords([{ text: "and" }], true)).toBe("And");
    expect(joinWords([{ text: "iPhone" }], true)).toBe("iPhone");
    expect(joinWords([{ text: "Already" }], true)).toBe("Already");
  });

  it("keeps punctuation that arrives as its own token attached", () => {
    expect(joinWords([
      { text: "Let's" }, { text: "ship" }, { text: "Friday" }, { text: "," }, { text: "if" },
    ])).toBe("Let's ship Friday, if");
  });
});

/* -------------------------------------------------------------------------- */
/* Provider corrections.                                                      */
/* -------------------------------------------------------------------------- */
describe("speaker revisions", () => {
  it("reads the field the provider actually sends", () => {
    // The live half of the interjection bug, and the whole of it. The provider
    // sends `{ type: "SpeakerRevision", revisions: [...] }`; this read
    // `message.turns`, which is never present, so *every* correction was
    // silently discarded. A turn the provider had not yet clustered arrived
    // labelled PENDING and stayed that way for the rest of the meeting, even
    // though the message naming it turned up moments later.
    let turns = applyTurn([], turn(3, "Exactly.", {
      end_of_turn: true, speaker_label: "PENDING",
    }), FIRST);
    expect(turns[0].speaker).toBe(UNKNOWN_SPEAKER);

    turns = applySpeakerRevision(turns, {
      type: "SpeakerRevision",
      revisions: [{ turn_order: 3, speaker_label: "B" }],
    }, FIRST);

    expect(turns[0]).toMatchObject({ speaker: "Speaker 1", speakerStatus: "attributed" });
  });

  it("relabels earlier turns when diarization changes its mind", () => {
    // Two voices indistinguishable in the first ten seconds separate cleanly by
    // the first minute. Applying the revision is what makes the live transcript
    // converge on the final one instead of drifting away from it.
    let turns = applyTurn([], turn(1, "Morning all.", {
      end_of_turn: true, speaker_label: "A",
    }), FIRST);
    turns = applySpeakerRevision(turns, {
      type: "SpeakerRevision",
      revisions: [{ turn_order: 1, speaker_label: "B" }],
    }, FIRST);

    // B is a voice this meeting has not heard before, so it takes the next
    // number rather than inheriting A's.
    expect(turns[0].speaker).toBe("Speaker 2");
  });

  it("splits a turn in place when the revision says two people spoke", () => {
    // Section 29, test I. The correction is "that was two people", and only
    // re-splitting can say so — and it must replace the line rather than add
    // one, or "exactly" appears twice.
    let turns = applyTurn([], turn(1, "We should ship Friday exactly.", {
      end_of_turn: true, speaker_label: "A",
    }), FIRST);
    expect(turns).toHaveLength(1);

    turns = applySpeakerRevision(turns, {
      type: "SpeakerRevision",
      revisions: [{
        turn_order: 1,
        speaker_label: "A",
        words: [
          w("We", "A", 0), w("should", "A", 400), w("ship", "A", 800), w("Friday", "A", 1200),
          w("exactly.", "B", 1600),
        ],
      }],
    }, FIRST);

    expect(turns.map((t) => [t.speaker, t.text])).toEqual([
      ["Speaker 1", "We should ship Friday"],
      ["Speaker 2", "Exactly."],
    ]);
    // No duplicate: the line it came from is gone, not sitting above it.
    expect(turns.filter((t) => t.text.toLowerCase().includes("exactly"))).toHaveLength(1);
  });

  it("does not take an attribution away once it has one", () => {
    let turns = applyTurn([], turn(1, "Morning.", { speaker_label: "A" }), FIRST);
    turns = applySpeakerRevision(turns, {
      type: "SpeakerRevision",
      revisions: [{ turn_order: 1, speaker_label: "UNKNOWN" }],
    }, FIRST);

    // A line flickering between a name and "Identifying speaker" is worse than
    // either, and the earlier answer was at least an answer.
    expect(turns[0].speaker).toBe("Speaker 1");
  });

  it("leaves the words alone", () => {
    let turns = applyTurn([], turn(1, "Settled words.", {
      end_of_turn: true, speaker_label: "A",
    }), FIRST);
    turns = applySpeakerRevision(turns, {
      type: "SpeakerRevision",
      revisions: [{ turn_order: 1, speaker_label: "B" }],
    }, FIRST);

    expect(turns[0].text).toBe("Settled words.");
    expect(turns[0].final).toBe(true);
  });

  it("only touches turns from the session being revised", () => {
    let turns = applyTurn([], turn(1, "First session.", { speaker_label: "A" }), FIRST);
    turns = applySpeakerRevision(turns, {
      type: "SpeakerRevision",
      revisions: [{ turn_order: 1, speaker_label: "C" }],
    }, { epoch: 2, offsetSeconds: 60 });

    expect(turns[0].speaker).toBe("Speaker 1");
  });

  it("returns the same array when nothing actually changed", () => {
    const before = applyTurn([], turn(1, "Morning.", { speaker_label: "A" }), FIRST);
    const after = applySpeakerRevision(before, {
      type: "SpeakerRevision",
      revisions: [{ turn_order: 1, speaker_label: "A" }],
    }, FIRST);

    expect(after).toBe(before);
  });

  it("ignores an empty revision", () => {
    const before = applyTurn([], turn(1, "Morning."), FIRST);
    expect(
      applySpeakerRevision(before, { type: "SpeakerRevision", revisions: [] }, FIRST),
    ).toBe(before);
  });

  it("still understands the older field name", () => {
    // Cheap insurance: `revisions` is what the wire carries today, and a
    // rename on the provider's side should not silently switch corrections off
    // again.
    let turns = applyTurn([], turn(1, "Morning.", { speaker_label: "A" }), FIRST);
    turns = applySpeakerRevision(turns, {
      type: "SpeakerRevision",
      turns: [{ turn_order: 1, speaker_label: "B" }],
    }, FIRST);

    expect(turns[0].speaker).toBe("Speaker 2");
  });
});
