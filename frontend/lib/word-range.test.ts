import { describe, it, expect } from "vitest";
import { wordRangeFor, tokenize } from "@/lib/moments";
import type { SpokenWord } from "@/lib/types";

/**
 * Turning a reader's selection into word positions.
 *
 * This is the join between what somebody dragged across and what the server can
 * split on. Getting it wrong by one moves the wrong words to another speaker,
 * and the transcript still reads plausibly afterwards — so nobody notices.
 *
 * The fixture is the reported shape: a question, a two-word reply and an
 * answer, delivered by the provider as one turn.
 */
const WORDS: SpokenWord[] = [
  { text: "Do", start: 57.0, end: 57.2 },
  { text: "you", start: 57.2, end: 57.4 },
  { text: "have", start: 57.4, end: 57.6 },
  { text: "a", start: 57.6, end: 57.7 },
  { text: "microwave?", start: 57.7, end: 58.8 },
  { text: "Yes,", start: 58.9, end: 59.1 },
  { text: "sir.", start: 59.1, end: 59.3 },
  { text: "I", start: 59.4, end: 59.6 },
  { text: "have", start: 59.6, end: 59.8 },
  { text: "one.", start: 59.8, end: 62.0 },
];

const SEGMENT = {
  text: "Do you have a microwave? Yes, sir. I have one.",
  start: 57.0,
  end: 62.0,
  words: WORDS,
};

/** Character offsets of a substring, the way a real selection reports them. */
function offsetsOf(needle: string): [number, number] {
  const from = SEGMENT.text.indexOf(needle);
  expect(from).toBeGreaterThanOrEqual(0);
  return [from, from + needle.length];
}

describe("wordRangeFor", () => {
  it("finds the buried short reply", () => {
    const [from, to] = offsetsOf("Yes, sir.");
    expect(wordRangeFor(SEGMENT, from, to)).toEqual({ fromWord: 5, toWord: 6 });
  });

  it("returns positions that index the same words the reader saw", () => {
    // The contract that makes this safe: position N here is words[N] there.
    // Recomputing boundaries separately would drift on punctuation.
    const [from, to] = offsetsOf("Yes, sir.");
    const span = wordRangeFor(SEGMENT, from, to)!;
    const picked = WORDS.slice(span.fromWord, span.toWord + 1).map((w) => w.text);
    expect(picked).toEqual(["Yes,", "sir."]);
    expect(tokenize(SEGMENT.text, SEGMENT.start, SEGMENT.end, WORDS)).toHaveLength(WORDS.length);
  });

  it("includes a word the selection only clipped", () => {
    // Dragging from the middle of "Yes," still means "Yes,". Requiring full
    // containment would drop the edges of every real drag.
    const start = SEGMENT.text.indexOf("Yes,") + 2;
    const end = SEGMENT.text.indexOf("sir.") + 2;
    expect(wordRangeFor(SEGMENT, start, end)).toEqual({ fromWord: 5, toWord: 6 });
  });

  it("handles a single word", () => {
    const [from, to] = offsetsOf("microwave?");
    expect(wordRangeFor(SEGMENT, from, to)).toEqual({ fromWord: 4, toWord: 4 });
  });

  it("reports the whole line when everything is selected", () => {
    expect(wordRangeFor(SEGMENT, 0, SEGMENT.text.length)).toEqual({
      fromWord: 0,
      toWord: WORDS.length - 1,
    });
  });

  it("refuses a line with no word timings rather than guessing", () => {
    // Splitting by character offset would give the new turn a start time that
    // corresponds to nothing in the audio.
    expect(wordRangeFor({ ...SEGMENT, words: [] }, 0, 5)).toBeNull();
    expect(wordRangeFor({ ...SEGMENT, words: null }, 0, 5)).toBeNull();
  });

  it("returns null for an empty selection", () => {
    expect(wordRangeFor(SEGMENT, 4, 4)).toBeNull();
  });
});
