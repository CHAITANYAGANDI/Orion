import { describe, it, expect } from "vitest";
import { MEETING_PROMPTS, WORKSPACE_PROMPTS } from "@/lib/chat-prompts";

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
