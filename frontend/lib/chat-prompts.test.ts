import { describe, it, expect } from "vitest";
import { MEETING_PROMPTS, WORKSPACE_PROMPTS, toPrompts } from "@/lib/chat-prompts";

/**
 * The starter prompts.
 *
 * These are the one place where a mistake is invisible in review and obvious to
 * a user: a prompt offered on the wrong surface still produces a confident
 * answer, just one grounded in the wrong meetings. "Compare these three
 * meetings" in a single-meeting chat cannot reach the other two, so it answers
 * from one transcript and says nothing about the failure.
 *
 * The trailing-space convention is load-bearing too — it is what tells the chip
 * to compose rather than send — and it is exactly the kind of thing an editor
 * that trims whitespace on save destroys silently.
 */
const ALL = [...MEETING_PROMPTS, ...WORKSPACE_PROMPTS];

describe("every prompt", () => {
  it("has a label and a prompt", () => {
    for (const p of ALL) {
      expect(p.label.trim().length).toBeGreaterThan(0);
      expect(p.prompt.trim().length).toBeGreaterThan(0);
    }
  });

  it("sends more than the chip shows", () => {
    // The label is a chip; the prompt has to carry enough to steer retrieval.
    // A prompt identical to its label is the signature of one having been
    // pasted over the other, which loses the steering silently.
    for (const p of ALL) {
      expect(p.prompt.trim(), p.label).not.toBe(p.label.trim());
    }
  });

  it("has a unique label within its list", () => {
    // Labels are React keys, and a duplicate silently drops a chip.
    for (const list of [MEETING_PROMPTS, WORKSPACE_PROMPTS]) {
      const labels = list.map((p) => p.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });
});

describe("the split between the two chats", () => {
  it("keeps cross-meeting questions out of the single-meeting chat", () => {
    // Meeting chat is grounded in one transcript. A comparison there has
    // nothing to reach for, and answers confidently from one meeting's chunks.
    const crossMeeting = /\b(across|compare|other meetings|my meetings|each meeting)\b/i;
    for (const p of MEETING_PROMPTS) {
      expect(crossMeeting.test(p.prompt), p.label).toBe(false);
    }
  });

  it("keeps single-meeting shortcuts out of the workspace chat", () => {
    // "Summarize this meeting" has no referent when the scope is every meeting.
    for (const p of WORKSPACE_PROMPTS) {
      expect(/\bthis meeting\b/i.test(p.prompt), p.label).toBe(false);
    }
  });
});

describe("toPrompts", () => {
  it("puts the generated questions first", () => {
    // They name the actual meeting. The hand-written ones would sit on any
    // meeting ever recorded, so they are what the row reaches only after.
    const pool = toPrompts(["What did the vendor commit to?"], MEETING_PROMPTS);

    expect(pool[0]).toEqual({
      label: "What did the vendor commit to?",
      prompt: "What did the vendor commit to?",
    });
  });

  it("keeps the written-by-hand ones behind them, to rotate through", () => {
    // Not a fallback any more. A meeting processed before the pool existed has
    // three stored questions and nothing else, and appending these is what
    // gives it a second row at all.
    const pool = toPrompts(["A?", "B?"], MEETING_PROMPTS);

    expect(pool.length).toBe(2 + MEETING_PROMPTS.length);
    expect(pool.slice(2)).toEqual(MEETING_PROMPTS);
  });

  it("is the written-by-hand set when nothing was generated", () => {
    // Every empty case has to land here, or a meeting still processing shows a
    // blank row where the chips should be.
    expect(toPrompts(undefined, MEETING_PROMPTS)).toEqual(MEETING_PROMPTS);
    expect(toPrompts(null, MEETING_PROMPTS)).toEqual(MEETING_PROMPTS);
    expect(toPrompts([], MEETING_PROMPTS)).toEqual(MEETING_PROMPTS);
  });

  it("is the written-by-hand set when the generated questions are all blank", () => {
    // A model that returns ["", "  "] must not produce two empty chips.
    expect(toPrompts(["", "   "], WORKSPACE_PROMPTS)).toEqual(WORKSPACE_PROMPTS);
  });

  it("drops the blanks but keeps the rest", () => {
    const pool = toPrompts(["  ", "A real question?"], MEETING_PROMPTS);

    expect(pool[0]).toEqual({ label: "A real question?", prompt: "A real question?" });
    expect(pool.some((p) => p.label.trim() === "")).toBe(false);
  });

  it("offers the same question once, however it arrived", () => {
    // The generator, asked for questions about a meeting, quite reasonably
    // proposes one the static set already has. Two identical chips in a row of
    // three is a third of the row wasted; further down the pool it is worse,
    // because rotation surfaces it later as though it were new.
    const pool = toPrompts(["What did we decide?"], MEETING_PROMPTS);

    expect(pool.filter((p) => p.label.toLowerCase() === "what did we decide?")).toHaveLength(1);
  });

  it("trims, so a stray newline does not become a chip that wraps", () => {
    expect(toPrompts(["  Padded?\n"], MEETING_PROMPTS)[0].label).toBe("Padded?");
  });

  it("never composes a generated question", () => {
    // A trailing space is the compose signal for the static set. A generated
    // one is complete, so it must not be left half-sent in the input box.
    const pool = toPrompts(["Did we settle the price? "], MEETING_PROMPTS);
    expect(pool[0].prompt.endsWith(" ")).toBe(false);
  });
});

describe("unfinished prompts", () => {
  it("marks openings with a trailing space rather than an example", () => {
    // The space is the signal to compose instead of send. A concrete example
    // ("Stripe") would be wrong for most workspaces and gets sent as-is by
    // anyone who clicks without reading.
    const unfinished = WORKSPACE_PROMPTS.filter((p) => p.prompt.endsWith(" "));
    expect(unfinished.map((p) => p.label).sort()).toEqual([
      "Find every mention of…",
      "What did someone say about…",
    ]);
  });

  it("ends a complete prompt with punctuation, not a space", () => {
    const complete = ALL.filter((p) => !p.prompt.endsWith(" "));
    for (const p of complete) {
      expect(/[.?]$/.test(p.prompt), p.label).toBe(true);
    }
  });
});
