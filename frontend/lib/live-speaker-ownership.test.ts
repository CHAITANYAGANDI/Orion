/**
 * Live speaker ownership, asserted against an exact provider event sequence.
 *
 * These exist because of a report that live recording had "stopped identifying
 * speakers", raised alongside a processed-transcript regression and suspected of
 * sharing a cause with it. The two paths share no code — the offline transcript
 * name inference lives in the ai-service and runs minutes later, on a different
 * machine, over a transcript this file never sees — and the last test here is
 * the proof rather than the claim.
 *
 * What is being pinned down is the property that actually broke on screen:
 * **a turn's owner is decided once and does not move.** Partial revisions,
 * formatting passes and end-of-turn finalisation all rewrite a line's text, and
 * any one of them rewriting its speaker is how an interjection ends up
 * attributed to whoever was talking around it.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CanonicalSpeakers } from "@/lib/canonical-speakers";
import {
  UNKNOWN_SPEAKER,
  applySpeakerRevision as revise,
  applyTurn as fold,
  finalTurns,
  type LiveTurn,
  type SessionContext,
} from "@/lib/live-turns";

const SESSION: SessionContext = { epoch: 1, offsetSeconds: 0 };

let speakers: CanonicalSpeakers;
beforeEach(() => {
  speakers = new CanonicalSpeakers();
});

function apply(turns: LiveTurn[], message: Parameters<typeof fold>[1]) {
  return fold(turns, message, SESSION, speakers);
}

/** One provider `Turn` message, with every word carrying a speaker. */
function turn(
  order: number,
  speaker: string | null,
  text: string,
  { final = false, start = order * 1000 }: { final?: boolean; start?: number } = {},
) {
  return {
    type: "Turn",
    turn_order: order,
    end_of_turn: final,
    turn_is_formatted: final,
    transcript: text,
    audio_start: start,
    speaker_label: speaker,
    words: text.split(" ").map((word, index) => ({
      text: word,
      start: start + index * 200,
      end: start + (index + 1) * 200,
      speaker,
      word_is_final: final,
    })),
  };
}

/** What is on screen: speaker per line, in order. */
function shown(turns: LiveTurn[]) {
  return finalTurns(turns).map((t) => [t.speaker, t.text] as const);
}

describe("G. two speakers, through partial and final", () => {
  it("keeps A as Speaker 1 and B as Speaker 2 across the exchange", () => {
    let state: LiveTurn[] = [];
    // The exact sequence: A partial, A final, B partial, B final, A again.
    state = apply(state, turn(0, "A", "Hi Michael how"));
    state = apply(state, turn(0, "A", "Hi Michael how are you", { final: true }));
    state = apply(state, turn(1, "B", "I'm good"));
    state = apply(state, turn(1, "B", "I'm good Charles", { final: true }));
    state = apply(state, turn(2, "A", "Did you finish the deployment", { final: true }));

    expect(shown(state)).toEqual([
      ["Speaker 1", "Hi Michael how are you"],
      ["Speaker 2", "I'm good Charles"],
      ["Speaker 1", "Did you finish the deployment"],
    ]);
  });

  it("finalising one turn does not rewrite an earlier turn's owner", () => {
    // The reported symptom, as an assertion. A late finalisation used to be
    // the moment several lines collapsed onto one name.
    let state: LiveTurn[] = [];
    state = apply(state, turn(0, "A", "First thing", { final: true }));
    state = apply(state, turn(1, "B", "Second thing"));
    const before = shown(state);

    state = apply(state, turn(1, "B", "Second thing entirely", { final: true }));

    expect(shown(state)[0]).toEqual(before[0]);
    expect(shown(state).map(([s]) => s)).toEqual(["Speaker 1", "Speaker 2"]);
  });

  it("a speaker number, once assigned, is never reused for another voice", () => {
    let state: LiveTurn[] = [];
    state = apply(state, turn(0, "A", "One", { final: true }));
    state = apply(state, turn(1, "B", "Two", { final: true }));
    state = apply(state, turn(2, "A", "Three", { final: true }));
    state = apply(state, turn(3, "C", "Four", { final: true }));

    expect(shown(state).map(([s]) => s)).toEqual([
      "Speaker 1",
      "Speaker 2",
      "Speaker 1",
      "Speaker 3",
    ]);
  });
});

describe("H. no speaker label from the provider", () => {
  it("uses the truthful fallback rather than inventing a second voice", () => {
    // The provider genuinely said nothing. Two unlabelled turns are not
    // evidence of two people, and must not be rendered as an alternation.
    let state: LiveTurn[] = [];
    state = apply(state, turn(0, null, "Something was said", { final: true }));
    state = apply(state, turn(1, null, "And then more", { final: true }));

    expect(shown(state).map(([s]) => s)).toEqual([UNKNOWN_SPEAKER, UNKNOWN_SPEAKER]);
    expect(finalTurns(state).every((t) => t.speakerStatus === "unknown")).toBe(true);
    expect(finalTurns(state).every((t) => t.speakerKey === null)).toBe(true);
  });

  it("an unattributed turn does not consume a speaker number", () => {
    // If it did, one unlabelled line early on would shift every later speaker
    // by one and the transcript would name people who were never identified.
    let state: LiveTurn[] = [];
    state = apply(state, turn(0, null, "Who said this", { final: true }));
    state = apply(state, turn(1, "A", "This one is labelled", { final: true }));

    expect(shown(state).map(([s]) => s)).toEqual([UNKNOWN_SPEAKER, "Speaker 1"]);
  });

  it("a provider placeholder is not a person", () => {
    // PENDING is the stream saying "not clustered yet". It used to fall
    // through to the real-name branch and render as somebody called PENDING.
    let state: LiveTurn[] = [];
    state = apply(state, turn(0, "PENDING", "Clustering has not caught up", { final: true }));

    expect(shown(state).map(([s]) => s)).toEqual([UNKNOWN_SPEAKER]);
  });
});

describe("I. offline transcript naming cannot reach the live path", () => {
  it("the same events produce identical ownership however the feature is set", () => {
    // There is no flag to toggle here, and that is the point: automatic
    // transcript naming is a server-side pass over a finished transcript. This
    // module has no path to it — no import, no shared state, no display-name
    // map — so the same events can only ever produce the same result.
    const events = [
      turn(0, "A", "Hi Michael how are you", { final: true }),
      turn(1, "B", "I'm good Charles", { final: true }),
      turn(2, "A", "Did you finish the deployment", { final: true }),
    ];

    const first = new CanonicalSpeakers();
    const second = new CanonicalSpeakers();
    const runWith = (registry: CanonicalSpeakers) =>
      events.reduce<LiveTurn[]>((acc, event) => fold(acc, event, SESSION, registry), []);

    const a = runWith(first);
    const b = runWith(second);

    expect(a.map((t) => [t.speakerKey, t.speakerRaw, t.speaker, t.at])).toEqual(
      b.map((t) => [t.speakerKey, t.speakerRaw, t.speaker, t.at]),
    );
    // And the names spoken in the audio changed nothing about who owns a line.
    expect(a.map((t) => t.speaker)).toEqual(["Speaker 1", "Speaker 2", "Speaker 1"]);
  });

  it("names said out loud never become live speaker labels", () => {
    // The live path must not do what the offline pass does. "Hi Michael" is a
    // name in the text and must stay in the text.
    let state: LiveTurn[] = [];
    state = apply(state, turn(0, "A", "Hi Michael how are you", { final: true }));
    state = apply(state, turn(1, "B", "I'm good Charles", { final: true }));

    const labels = finalTurns(state).map((t) => t.speaker);
    expect(labels).toEqual(["Speaker 1", "Speaker 2"]);
    expect(labels.join(" ")).not.toContain("Michael");
    expect(labels.join(" ")).not.toContain("Charles");
  });
});

describe("SpeakerRevision is applied, not merely logged", () => {
  /** A revision message shaped as the provider documents it. */
  function revision(order: number, label: string, words?: { text: string; speaker: string; start: number }[]) {
    return {
      type: "SpeakerRevision",
      revisions: [{ turn_order: order, speaker_label: label, words: words ?? [] }],
    };
  }

  it("relabels an already-final buffered turn from one speaker to another", () => {
    // The case that matters: the turn is settled and on screen under
    // Speaker 1, and the provider then says it was the other person. If this
    // were only logged, the transcript would keep the wrong name for ever.
    let state: LiveTurn[] = [];
    state = apply(state, turn(0, "A", "First thing said", { final: true }));
    state = apply(state, turn(1, "B", "Second thing said", { final: true }));
    expect(shown(state).map(([s]) => s)).toEqual(["Speaker 1", "Speaker 2"]);

    state = revise(state, revision(0, "B"), SESSION, speakers);

    // Turn 0 now belongs to the voice already known as Speaker 2 -- the same
    // canonical identity, not a third number invented for the revision.
    expect(shown(state).map(([s]) => s)).toEqual(["Speaker 2", "Speaker 2"]);
    expect(finalTurns(state)[0].speakerKey).toBe(finalTurns(state)[1].speakerKey);
    expect(finalTurns(state)[0].speakerRaw).toBe("B");
  });

  it("a revision naming a voice not yet heard gets the next number", () => {
    let state: LiveTurn[] = [];
    state = apply(state, turn(0, "A", "Only speaker so far", { final: true }));

    state = revise(state, revision(0, "C"), SESSION, speakers);

    expect(shown(state).map(([s]) => s)).toEqual(["Speaker 2"]);
    expect(finalTurns(state)[0].speakerRaw).toBe("C");
  });

  it("resolves a PENDING turn once the provider has clustered it", () => {
    // The common case in a live session: clustering has not caught up, the
    // turn arrives unattributed, and the answer follows moments later.
    let state: LiveTurn[] = [];
    state = apply(state, turn(0, "PENDING", "Said before clustering caught up", { final: true }));
    expect(shown(state).map(([s]) => s)).toEqual([UNKNOWN_SPEAKER]);

    state = revise(state, revision(0, "A"), SESSION, speakers);

    expect(shown(state).map(([s]) => s)).toEqual(["Speaker 1"]);
    expect(finalTurns(state)[0].speakerStatus).toBe("attributed");
  });

  it("does not take attribution back away", () => {
    // A revision to PENDING after a real answer is a line flickering between
    // two states, and the earlier one was at least an answer.
    let state: LiveTurn[] = [];
    state = apply(state, turn(0, "A", "Attributed already", { final: true }));

    state = revise(state, revision(0, "PENDING"), SESSION, speakers);

    expect(shown(state).map(([s]) => s)).toEqual(["Speaker 1"]);
  });

  it("splits a turn when the revision's words disagree with each other", () => {
    // The interjection case: the provider decides mid-turn that two people
    // spoke. The buffered single line becomes two, each owned separately.
    let state: LiveTurn[] = [];
    state = apply(state, turn(0, "A", "Long stretch by one person", { final: true }));

    state = revise(state, revision(0, "A", [
      { text: "Long", speaker: "A", start: 0 },
      { text: "stretch", speaker: "A", start: 200 },
      { text: "by", speaker: "B", start: 400 },
      { text: "one", speaker: "A", start: 600 },
      { text: "person", speaker: "A", start: 800 },
    ]), SESSION, speakers);

    expect(finalTurns(state).map((t) => t.speakerRaw)).toEqual(["A", "B", "A"]);
  });

  it("a revision for a turn from a previous session is ignored", () => {
    // Turn orders restart at zero after a reconnect. Without the epoch in the
    // key, a revision would relabel the wrong line entirely.
    let state: LiveTurn[] = [];
    state = apply(state, turn(0, "A", "From the first session", { final: true }));

    const later: SessionContext = { epoch: 2, offsetSeconds: 30 };
    state = revise(state, revision(0, "B"), later, speakers);

    expect(shown(state).map(([s]) => s)).toEqual(["Speaker 1"]);
  });
});
