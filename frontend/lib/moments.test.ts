import { describe, it, expect } from "vitest";
import {
  askPrefix,
  attributedQuote,
  isMarked,
  isOrphaned,
  rangesFromWords,
  resolveRange,
  segmentMarks,
  summarizePrompt,
  tokenize,
  type WordRef,
} from "@/lib/moments";
import type { MomentRange, TranscriptMoment } from "@/lib/types";

/**
 * Anchoring a mark to a transcript that people are allowed to edit.
 *
 * The failure this file exists to prevent is not an exception — it is a
 * highlight that resolves cleanly onto the wrong words. Correcting a typo near
 * the start of a line shifts every offset after it, so offsets alone slide
 * silently, and a reader has no way to know the app is now showing them
 * something they never marked. Every test below is a version of "does it move,
 * and does it admit when it cannot find itself".
 */

const word = (over: Partial<WordRef> = {}): WordRef => ({
  segmentId: "seg_1",
  from: 0,
  to: 5,
  text: "hello ",
  start: 1,
  end: 2,
  speaker: "Priya",
  ...over,
});

/* ------------------------------ tokenize -------------------------------- */
describe("tokenize", () => {
  it("reports offsets that slice back to the same words", () => {
    // This is the contract the whole feature rests on: a selection is stored as
    // text.slice(from, to), so if these two disagree by even a character every
    // highlight fails to resolve the moment it is reloaded.
    const text = "We should ship on Thursday.";
    for (const t of tokenize(text, 0, 5)) {
      expect(text.slice(t.from, t.to)).toBe(t.text.trimEnd());
    }
  });

  it("joins back into the original text", () => {
    const text = "Two  spaces and a trailing gap.  ";
    expect(
      tokenize(text, 0, 5)
        .map((t) => t.text)
        .join(""),
    ).toBe(text);
  });

  it("keeps a double space rather than normalising it", () => {
    // A normalised quote would be neither what the offsets point at nor
    // something indexOf could find, so the mark would be unrecoverable.
    const text = "before  after";
    const [first, second] = tokenize(text, 0, 5);
    expect(first.text).toBe("before  ");
    expect(text.slice(first.from, second.to)).toBe("before  after");
  });

  it("uses the provider's timings when it has them", () => {
    const tokens = tokenize("hello world", 0, 10, [
      { text: "hello", start: 0.5, end: 0.9 },
      { text: "world", start: 1.4, end: 1.8 },
    ]);
    expect(tokens.map((t) => t.start)).toEqual([0.5, 1.4]);
    // Located in the text rather than assumed: the provider's word list and the
    // segment text are two renderings of the same speech.
    expect(tokens[1].from).toBe(6);
  });

  it("estimates when there are none", () => {
    // Transcripts recorded before word timings were persisted.
    const tokens = tokenize("one two", 10, 20);
    expect(tokens[0].start).toBe(10);
    expect(tokens[1].start).toBeGreaterThan(10);
    expect(tokens[1].end).toBeLessThanOrEqual(20);
  });

  it("handles an empty utterance", () => {
    expect(tokenize("", 0, 1)).toEqual([]);
  });
});

/* --------------------------- rangesFromWords ---------------------------- */
describe("rangesFromWords", () => {
  it("makes one range per segment", () => {
    // Diarization splits on pauses, not sentences, so one spoken sentence
    // routinely lands in two segments — and their offsets index two different
    // strings, which is why a single range cannot span them.
    const capture = rangesFromWords([
      word({ segmentId: "seg_1", from: 10, to: 16, text: "should ", start: 1, end: 2 }),
      word({ segmentId: "seg_1", from: 17, to: 21, text: "ship ", start: 2, end: 3 }),
      word({ segmentId: "seg_2", from: 0, to: 2, text: "on ", start: 3, end: 4 }),
    ]);

    expect(capture?.ranges).toHaveLength(2);
    expect(capture?.ranges[0]).toMatchObject({ segmentId: "seg_1", startOffset: 10, endOffset: 21 });
    expect(capture?.ranges[1]).toMatchObject({ segmentId: "seg_2", startOffset: 0, endOffset: 2 });
  });

  it("spans the whole selection in time", () => {
    const capture = rangesFromWords([
      word({ start: 4, end: 5 }),
      word({ from: 6, to: 9, start: 5, end: 9 }),
    ]);
    expect(capture?.startSeconds).toBe(4);
    expect(capture?.endSeconds).toBe(9);
  });

  it("names the speaker it starts with", () => {
    // A selection across a handover has two. Naming the first is truthful and
    // stable; "Priya and Marcus" would have to be re-derived every time the
    // moment is displayed.
    const capture = rangesFromWords([
      word({ speaker: "Priya" }),
      word({ segmentId: "seg_2", speaker: "Marcus" }),
    ]);
    expect(capture?.speaker).toBe("Priya");
  });

  it("trims each range's quote but keeps the words", () => {
    const capture = rangesFromWords([word({ text: "hello " }), word({ from: 6, to: 11, text: "world " })]);
    expect(capture?.quote).toBe("hello world");
  });

  it("is null for no words", () => {
    // The signal to leave the menu closed rather than open one over nothing.
    expect(rangesFromWords([])).toBeNull();
  });

  it("is null when the selection is only whitespace", () => {
    expect(rangesFromWords([word({ text: "   " })])).toBeNull();
  });
});

/* ---------------------------- resolveRange ------------------------------ */
describe("resolveRange", () => {
  const text = "We should ship on Thursday.";
  const range = (over: Partial<MomentRange> = {}): MomentRange => ({
    segmentId: "seg_1",
    startOffset: 10,
    endOffset: 14,
    quote: "ship",
    ...over,
  });

  it("takes the offsets when the words there are still the right words", () => {
    expect(resolveRange(text, range())).toEqual({ start: 10, end: 14 });
  });

  it("finds the words again after an edit shifted them", () => {
    // Somebody fixed a typo earlier in the line. The offsets still resolve —
    // to the wrong words — which is exactly why they are verified rather than
    // trusted.
    const edited = "Well, we should ship on Thursday.";
    expect(resolveRange(edited, range())).toEqual({ start: 16, end: 20 });
    expect(edited.slice(16, 20)).toBe("ship");
  });

  it("prefers the occurrence nearest where the mark used to be", () => {
    // Without this a repeated phrase jumps to the top of the line after an
    // unrelated edit, and the user's highlight silently moves.
    const repeated = "ship it, then ship it again, then ship it once more";
    const at = resolveRange(repeated, range({ startOffset: 34, endOffset: 38 }));
    expect(at).toEqual({ start: 34, end: 38 });
  });

  it("gives up when the words are gone", () => {
    // Null is the honest answer. Drawing something here would put a highlight
    // over a sentence the user never marked.
    expect(resolveRange("Entirely rewritten.", range())).toBeNull();
  });

  it("falls back to bare offsets when there is no quote", () => {
    expect(resolveRange(text, range({ quote: "" }))).toEqual({ start: 10, end: 14 });
  });

  it("rejects bare offsets that run past the end of the line", () => {
    // A line shortened by an edit. Slicing past the end returns a short string
    // rather than throwing, so this has to be checked.
    expect(resolveRange("short", range({ quote: "", startOffset: 10, endOffset: 40 }))).toBeNull();
  });

  it("rejects an empty span", () => {
    expect(resolveRange(text, range({ quote: "", startOffset: 5, endOffset: 5 }))).toBeNull();
  });
});

/* ---------------------------- segmentMarks ------------------------------ */
const moment = (over: Partial<TranscriptMoment> = {}): TranscriptMoment => ({
  id: "mom_1",
  meetingId: "mtg_1",
  kind: "HIGHLIGHT",
  ranges: [{ segmentId: "seg_1", startOffset: 10, endOffset: 14, quote: "ship" }],
  quote: "ship",
  body: "",
  speaker: "Priya",
  startSeconds: 12,
  endSeconds: 13,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
  ...over,
});

describe("segmentMarks", () => {
  const text = "We should ship on Thursday.";

  it("resolves the marks on one segment", () => {
    expect(segmentMarks("seg_1", text, [moment()])).toEqual([
      { start: 10, end: 14, moment: expect.objectContaining({ id: "mom_1" }) },
    ]);
  });

  it("ignores marks belonging to other segments", () => {
    expect(segmentMarks("seg_2", text, [moment()])).toEqual([]);
  });

  it("leaves bookmarks out", () => {
    // A bookmark marks a time, not a passage — there is nothing to draw over
    // the words, and drawing the whole turn would be a claim the user did not
    // make.
    expect(segmentMarks("seg_1", text, [moment({ kind: "BOOKMARK" })])).toEqual([]);
  });

  it("drops a mark whose words no longer exist", () => {
    expect(segmentMarks("seg_1", "Entirely rewritten.", [moment()])).toEqual([]);
  });

  it("returns marks in reading order", () => {
    const later = moment({
      id: "mom_2",
      ranges: [{ segmentId: "seg_1", startOffset: 18, endOffset: 26, quote: "Thursday" }],
    });
    expect(segmentMarks("seg_1", text, [later, moment()]).map((m) => m.start)).toEqual([10, 18]);
  });
});

describe("isMarked", () => {
  const marks = [{ start: 10, end: 14, moment: moment() }];

  it("matches a word inside the mark", () => {
    expect(isMarked(marks, 10, 14)).toBeTruthy();
  });

  it("matches a word the mark only overlaps", () => {
    // A mark repaired by searching for its quote can land a character off a
    // word boundary when the surrounding text changed width.
    expect(isMarked(marks, 12, 20)).toBeTruthy();
  });

  it("does not match a word that merely touches the edge", () => {
    expect(isMarked(marks, 14, 18)).toBeFalsy();
    expect(isMarked(marks, 5, 10)).toBeFalsy();
  });
});

/* ----------------------------- isOrphaned ------------------------------- */
describe("isOrphaned", () => {
  const text = () => "We should ship on Thursday.";

  it("is false while the words are still there", () => {
    expect(isOrphaned(moment(), text)).toBe(false);
  });

  it("is true once the line was rewritten", () => {
    // Shown in the list rather than dropped: dropping it looks like the app
    // lost the mark, and the quote and timestamp still lead back to the moment.
    expect(isOrphaned(moment(), () => "Entirely rewritten.")).toBe(true);
  });

  it("is true when the segment itself is gone", () => {
    expect(isOrphaned(moment(), () => undefined)).toBe(true);
  });

  it("is false for a bookmark, which has no words to lose", () => {
    expect(isOrphaned(moment({ kind: "BOOKMARK", ranges: [] }), () => undefined)).toBe(false);
  });

  it("is false while any one range still resolves", () => {
    // A selection spanning two utterances where only one was edited is still
    // findable, and still drawn on the half that survived.
    const across = moment({
      ranges: [
        { segmentId: "seg_1", startOffset: 10, endOffset: 14, quote: "ship" },
        { segmentId: "seg_9", startOffset: 0, endOffset: 4, quote: "gone" },
      ],
    });
    expect(isOrphaned(across, (id) => (id === "seg_1" ? text() : undefined))).toBe(false);
  });
});

/* ------------------------------ prompts --------------------------------- */
describe("attributedQuote", () => {
  it("carries the speaker and the timecode", () => {
    // A transcript line pasted bare into a ticket loses the two things that
    // made it evidence.
    expect(attributedQuote({ speaker: "Priya", startSeconds: 754, quote: "we ship Thursday" }))
      .toBe("Priya (12:34): “we ship Thursday”");
  });

  it("says so when nobody was attributed", () => {
    expect(attributedQuote({ speaker: "  ", startSeconds: 0, quote: "x" })).toContain(
      "Unknown speaker",
    );
  });
});

describe("chat prompts", () => {
  it("leaves an ask unfinished", () => {
    // Only the user knows what they wanted to ask about the passage.
    const prefix = askPrefix("we ship Thursday");
    expect(prefix).toContain("we ship Thursday");
    expect(prefix.endsWith("\n\n")).toBe(true);
  });

  it("makes a summarize prompt complete, so it sends", () => {
    expect(summarizePrompt("we ship Thursday")).toMatch(/\bSummarize\b.*we ship Thursday/s);
  });

  it("clips a long passage so the request is not rejected", () => {
    // The chat endpoint caps a question at 2000 characters. A prompt refused by
    // validation reads as a menu item that does nothing.
    const long = "word ".repeat(2000);
    expect(summarizePrompt(long).length).toBeLessThan(2000);
    expect(askPrefix(long).length).toBeLessThan(2000);
    expect(summarizePrompt(long)).toContain("…");
  });
});
