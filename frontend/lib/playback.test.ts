import { describe, it, expect } from "vitest";
import {
  MIN_SILENCE,
  highlightSpans,
  insideSpan,
  nextSpanStart,
  nextSpeakerStart,
  previousSpeakerStart,
  progressFraction,
  seekTarget,
  silenceSkip,
  speakerTurns,
} from "@/lib/playback";
import type { TranscriptMoment, TranscriptSegment } from "@/lib/types";

/**
 * The transcript-driven half of playback.
 *
 * Every one of these looks like an audio feature and none of them are. Recallix
 * already knows, to the word, who spoke and when — so the gaps between
 * utterances *are* the silence and a change of speaker *is* the boundary.
 * Testing them against times rather than against a media element is what makes
 * them testable at all: jsdom has no playback, so anything that reached for the
 * signal would be verifiable only by ear.
 */
function seg(start: number, end: number, speaker = "Priya"): TranscriptSegment {
  return { id: `seg_${start}`, start, end, speaker, text: "words" };
}

function moment(start: number, end: number, over: Partial<TranscriptMoment> = {}): TranscriptMoment {
  return {
    id: `mom_${start}`,
    meetingId: "mtg_1",
    kind: "HIGHLIGHT",
    ranges: [],
    quote: "words",
    body: "",
    speaker: "Priya",
    startSeconds: start,
    endSeconds: end,
    createdAt: "2026-08-15T09:00:00Z",
    updatedAt: "2026-08-15T09:00:00Z",
    ...over,
  };
}

/* ----------------------------- speaker turns ---------------------------- */
describe("speakerTurns", () => {
  it("merges consecutive utterances by one speaker", () => {
    // Diarization splits on pauses, so "the next speaker" is not the next
    // segment — without merging, a next-speaker button advances a second and a
    // half into the same person's sentence.
    const turns = speakerTurns([
      seg(0, 5, "Priya"),
      seg(5, 9, "Priya"),
      seg(9, 14, "Marcus"),
    ]);
    expect(turns).toEqual([
      { start: 0, end: 9, speaker: "Priya" },
      { start: 9, end: 14, speaker: "Marcus" },
    ]);
  });

  it("starts a new turn when the speaker comes back", () => {
    const turns = speakerTurns([seg(0, 5, "A"), seg(5, 9, "B"), seg(9, 12, "A")]);
    expect(turns.map((t) => t.speaker)).toEqual(["A", "B", "A"]);
  });

  it("handles an empty transcript", () => {
    expect(speakerTurns([])).toEqual([]);
  });
});

describe("nextSpeakerStart", () => {
  const turns = speakerTurns([seg(0, 10, "A"), seg(10, 20, "B"), seg(20, 30, "A")]);

  it("finds the next handover", () => {
    expect(nextSpeakerStart(turns, 4)).toBe(10);
  });

  it("is null at the last turn", () => {
    // Null rather than the duration: the button should do nothing, not seek to
    // the end of the recording.
    expect(nextSpeakerStart(turns, 25)).toBeNull();
  });

  it("does not stick when the playhead is a hair short of a boundary", () => {
    // Floating-point playback positions land just under boundaries constantly;
    // without tolerance the button becomes a no-op exactly when it is pressed
    // hardest.
    expect(nextSpeakerStart(turns, 9.98)).toBe(20);
  });
});

describe("previousSpeakerStart", () => {
  const turns = speakerTurns([seg(0, 10, "A"), seg(10, 20, "B"), seg(20, 30, "A")]);

  it("restarts the current turn first", () => {
    // The track-back convention: once means "from the top of this bit".
    expect(previousSpeakerStart(turns, 15)).toBe(10);
  });

  it("goes further back when pressed again near the start", () => {
    expect(previousSpeakerStart(turns, 10.5)).toBe(0);
  });

  it("stays at the first turn rather than going negative", () => {
    expect(previousSpeakerStart(turns, 0.5)).toBe(0);
  });

  it("handles a playhead before any speech", () => {
    expect(previousSpeakerStart(turns, -1)).toBe(0);
    expect(previousSpeakerStart([], 5)).toBeNull();
  });
});

/* ------------------------------ skip silence ---------------------------- */
describe("silenceSkip", () => {
  // A gap of 8s between the two utterances, and 3s of dead air at the start.
  const segments = [seg(3, 10), seg(18, 25)];

  it("jumps out of a gap to the next word", () => {
    expect(silenceSkip(segments, 12)).toBe(18);
  });

  it("skips the dead air before anyone speaks", () => {
    // On a recording that opens with people joining, this is routinely the
    // longest silence in the file.
    expect(silenceSkip(segments, 0)).toBe(3);
  });

  it("is null while somebody is talking", () => {
    // Null rather than the current position, so the caller can tell "nothing to
    // do" from "move here" without comparing floats.
    expect(silenceSkip(segments, 5)).toBeNull();
    expect(silenceSkip(segments, 20)).toBeNull();
  });

  it("leaves a short pause alone", () => {
    // Shorter than the threshold and the jump is more jarring than the pause.
    expect(silenceSkip([seg(0, 5), seg(5.4, 10)], 5.2)).toBeNull();
  });

  it("respects a custom threshold", () => {
    expect(silenceSkip([seg(0, 5), seg(5.4, 10)], 5.2, 0.2)).toBe(5.4);
  });

  it("does not jump when already at the far edge of a gap", () => {
    // Otherwise it fires every frame at the boundary and the playhead sticks.
    expect(silenceSkip(segments, 17.99)).toBeNull();
  });

  it("is null after the last word", () => {
    // Trailing silence is the end of the recording; skipping it would be
    // indistinguishable from ending playback early.
    expect(silenceSkip(segments, 30)).toBeNull();
  });

  it("handles an empty transcript", () => {
    expect(silenceSkip([], 5)).toBeNull();
  });

  it("has a sane default threshold", () => {
    expect(MIN_SILENCE).toBeGreaterThan(0);
  });
});

/* --------------------------- highlights only ---------------------------- */
describe("highlightSpans", () => {
  it("takes the marked stretches in order", () => {
    expect(highlightSpans([moment(30, 40), moment(10, 20)])).toEqual([
      { start: 10, end: 20 },
      { start: 30, end: 40 },
    ]);
  });

  it("merges overlapping marks", () => {
    // Two highlights on one sentence must not make the playhead stutter
    // between them.
    expect(highlightSpans([moment(10, 20), moment(15, 25)])).toEqual([{ start: 10, end: 25 }]);
  });

  it("merges marks that touch exactly", () => {
    expect(highlightSpans([moment(10, 20), moment(20, 30)])).toEqual([{ start: 10, end: 30 }]);
  });

  it("leaves a gap between marks that do not touch", () => {
    expect(highlightSpans([moment(10, 20), moment(21, 30)])).toHaveLength(2);
  });

  it("drops bookmarks, which mark an instant", () => {
    // A zero-length span has nothing to play, and treating it as one would
    // stall the playhead on a single frame.
    expect(highlightSpans([moment(30, 30, { kind: "BOOKMARK" })])).toEqual([]);
  });

  it("keeps notes, which do have a passage", () => {
    expect(highlightSpans([moment(10, 20, { kind: "NOTE", body: "check" })])).toHaveLength(1);
  });
});

describe("playing only the spans", () => {
  const spans = highlightSpans([moment(10, 20), moment(40, 50)]);

  it("knows when it is inside one", () => {
    expect(insideSpan(spans, 15)).toBe(true);
    expect(insideSpan(spans, 25)).toBe(false);
  });

  it("treats the end as exclusive, so it moves on", () => {
    expect(insideSpan(spans, 20)).toBe(false);
  });

  it("finds the next span to jump to", () => {
    expect(nextSpanStart(spans, 0)).toBe(10);
    expect(nextSpanStart(spans, 25)).toBe(40);
  });

  it("is null after the last one, meaning stop", () => {
    // Wrapping back to the top would make a short set of highlights play for
    // ever, which is not what "play my highlights" asks for.
    expect(nextSpanStart(spans, 55)).toBeNull();
  });
});

/* ------------------------------- scrubber ------------------------------- */
describe("progressFraction", () => {
  it("is the fraction played", () => {
    expect(progressFraction(30, 120)).toBe(0.25);
  });

  it("is zero before metadata gives a duration", () => {
    // NaN in a CSS width silently renders nothing, so the bar would vanish
    // rather than sit at zero.
    expect(progressFraction(30, 0)).toBe(0);
    expect(progressFraction(30, NaN)).toBe(0);
    expect(progressFraction(30, Infinity)).toBe(0);
  });

  it("clamps a playhead past the end", () => {
    expect(progressFraction(200, 120)).toBe(1);
    expect(progressFraction(-5, 120)).toBe(0);
  });
});

describe("seekTarget", () => {
  it("maps a click to a time", () => {
    expect(seekTarget(0.5, 120)).toBe(60);
  });

  it("clamps outside the bar", () => {
    expect(seekTarget(1.4, 120)).toBe(120);
    expect(seekTarget(-0.2, 120)).toBe(0);
  });

  it("is zero with no duration yet", () => {
    expect(seekTarget(0.5, 0)).toBe(0);
  });
});
