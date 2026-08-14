import { describe, it, expect } from "vitest";
import { toMarkdown, markdownFilename } from "@/lib/export-markdown";
import type { MeetingResponse, SummaryResponse } from "@/lib/types";

/**
 * The markdown export.
 *
 * This is the one artefact that leaves Recallix. It gets pasted into Notion, a
 * doc, a commit message — read by people who were not in the meeting and cannot
 * check it against the recording. So the failures worth guarding are the ones
 * that change what it claims rather than how it looks:
 *
 * * a summary printed twice, once as sections and once flattened, so the reader
 *   sees two versions of the same notes and cannot tell which is current
 * * an empty section silently dropped, which makes "budget never came up"
 *   indistinguishable from "we never asked about budget"
 * * a completed action item exported as outstanding
 */
const meeting: MeetingResponse = {
  id: "mtg_1",
  title: "Acme kickoff",
  status: "READY",
  tags: ["sales", "q3"],
  durationSeconds: 1830,
  createdAt: "2026-08-13T14:30:00Z",
};

function md(over: Partial<Parameters<typeof toMarkdown>[0]> = {}) {
  return toMarkdown({ meeting, ...over });
}

describe("the header", () => {
  it("opens with the meeting title as an h1", () => {
    expect(md().split("\n")[0]).toBe("# Acme kickoff");
  });

  it("carries the length and tags", () => {
    const out = md();
    expect(out).toContain("31 min");
    expect(out).toContain("sales, q3");
  });

  it("omits the length rather than printing zero for a document", () => {
    const out = toMarkdown({ meeting: { ...meeting, durationSeconds: null } });
    expect(out).not.toContain("0 min");
  });
});

describe("a template-shaped summary", () => {
  const summary: SummaryResponse = {
    meetingId: "mtg_1",
    shortSummary: "Short.",
    detailedSummary: "Detailed.",
    keyPoints: ["A key point."],
    sections: [
      { key: "overview", title: "Overview", kind: "prose", text: "We agreed terms.", bullets: [], groups: [] },
      { key: "decisions", title: "Decisions", kind: "bullets", text: "", bullets: ["Ship on the 14th."], groups: [] },
      {
        key: "outline",
        title: "Outline",
        kind: "outline",
        text: "",
        bullets: [],
        groups: [{ heading: "Pricing", bullets: ["Discussed tiers."] }],
      },
    ],
  };

  it("exports the sections", () => {
    const out = toMarkdown({ meeting, summary });
    expect(out).toContain("## Overview");
    expect(out).toContain("We agreed terms.");
    expect(out).toContain("- Ship on the 14th.");
    expect(out).toContain("### Pricing");
  });

  it("does not also print the flattened copy", () => {
    // `detailedSummary` is the same notes rendered flat. Emitting both prints
    // the key points twice and turns the headings into plain lines.
    const out = toMarkdown({ meeting, summary });
    expect(out).not.toContain("Detailed.");
    expect(out).not.toContain("## Key points");
  });

  it("keeps an empty section and says it was empty", () => {
    const out = toMarkdown({
      meeting,
      summary: {
        ...summary,
        sections: [
          { key: "risks", title: "Risks", kind: "bullets", text: "", bullets: [], groups: [] },
        ],
      },
    });
    expect(out).toContain("## Risks");
    expect(out).toContain("_Not discussed._");
  });
});

describe("a summary written before templates existed", () => {
  it("falls back to the flat fields", () => {
    const out = toMarkdown({
      meeting,
      summary: {
        meetingId: "mtg_1",
        shortSummary: "Short.",
        detailedSummary: "Detailed.",
        keyPoints: ["A key point."],
      },
    });
    expect(out).toContain("## Summary");
    expect(out).toContain("Short.");
    expect(out).toContain("Detailed.");
    expect(out).toContain("- A key point.");
  });

  it("prints the detailed summary once when it duplicates the short one", () => {
    const out = toMarkdown({
      meeting,
      summary: {
        meetingId: "mtg_1",
        shortSummary: "Same text.",
        detailedSummary: "Same text.",
        keyPoints: [],
      },
    });
    expect(out.split("Same text.").length - 1).toBe(1);
  });
});

describe("action items", () => {
  it("exports status as a checkbox a reader can act on", () => {
    const out = toMarkdown({
      meeting,
      actionItems: [
        { id: "a1", meetingId: "mtg_1", title: "Send the deck", status: "DONE", priority: "high" },
        { id: "a2", meetingId: "mtg_1", title: "Draft the SOW", status: "OPEN", priority: "medium" },
      ] as never,
    });
    // A finished item exported as outstanding sends somebody to redo it.
    expect(out).toContain("- [x] Send the deck");
    expect(out).toContain("- [ ] Draft the SOW");
  });

  it("attaches owner and due date to the item they belong to", () => {
    const out = toMarkdown({
      meeting,
      actionItems: [
        {
          id: "a1",
          meetingId: "mtg_1",
          title: "Send the deck",
          status: "OPEN",
          ownerName: "Sarah",
          dueDate: "2026-08-20",
          priority: "high",
        },
      ] as never,
    });
    expect(out).toContain("Send the deck — _Sarah · due 2026-08-20 · high_");
  });

  it("omits the section entirely when there are none", () => {
    expect(md()).not.toContain("## Action items");
  });
});

describe("the transcript", () => {
  const segments = [
    { id: "s1", start: 0, end: 5, speaker: "Alice", text: "Hello." },
    { id: "s2", start: 65, end: 70, speaker: "Bob", text: "Hi." },
  ];

  it("is left out unless it was asked for", () => {
    // It is the bulk of the file and the most sensitive part of it, so the
    // default has to be the quiet one.
    expect(toMarkdown({ meeting, segments } as never)).not.toContain("## Transcript");
  });

  it("is included with timecodes and speakers when requested", () => {
    const out = toMarkdown({ meeting, segments, includeTranscript: true } as never);
    expect(out).toContain("**[00:00] Alice:** Hello.");
    expect(out).toContain("**[01:05] Bob:** Hi.");
  });
});

describe("markdownFilename", () => {
  it("slugs the title", () => {
    expect(markdownFilename("Acme Kickoff — Q3")).toBe("acme-kickoff-q3.md");
  });

  it("never produces a name that is only punctuation", () => {
    // A meeting called "???" would otherwise download as ".md", which some
    // browsers treat as a hidden file with no name.
    expect(markdownFilename("???")).toBe("meeting.md");
    expect(markdownFilename("")).toBe("meeting.md");
  });

  it("caps the length so the OS accepts it", () => {
    expect(markdownFilename("x".repeat(200)).length).toBeLessThanOrEqual(63);
  });

  it("strips characters a filesystem would reject", () => {
    expect(markdownFilename("a/b\\c:d")).toBe("a-b-c-d.md");
  });
});
