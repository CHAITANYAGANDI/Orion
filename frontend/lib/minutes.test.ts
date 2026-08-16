import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  copyMinutes,
  copySummary,
  minutesHtml,
  minutesText,
  summaryText,
  writeRich,
  type MinutesInput,
} from "@/lib/minutes";
import type { ActionItemResponse, Insight, MeetingResponse, SummaryResponse } from "@/lib/types";

/**
 * What ends up on the clipboard.
 *
 * <p>The failures here are all silent. Markdown asterisks pasted into an email,
 * a stray angle bracket from a transcript closing a tag, a heading with nothing
 * under it that makes a document look unfinished — every one of them renders
 * without complaint and is only noticed by whoever receives it.
 */
const MEETING: MeetingResponse = {
  id: "mtg_1",
  title: "Sprint planning",
  status: "READY",
  tags: [],
  createdAt: "2026-08-15T14:00:00Z",
  durationSeconds: 3600,
};

function input(over: Partial<MinutesInput> = {}): MinutesInput {
  return {
    meeting: MEETING,
    summary: {
      shortSummary: "We agreed to move billing to Stripe.",
      detailedSummary: "We agreed to move billing to Stripe. Marcus will draft the plan.",
      keyPoints: ["Stripe by Q4", "Marcus drafts the plan"],
    } as SummaryResponse,
    actionItems: [
      {
        id: "ai_1",
        meetingId: "mtg_1",
        title: "Draft the rollout plan",
        ownerName: "Marcus",
        dueDate: "2026-08-20",
        priority: "high",
        status: "OPEN",
      } as ActionItemResponse,
    ],
    insights: [
      { id: "ins_1", meetingId: "mtg_1", kind: "DECISION", text: "Move billing to Stripe" } as Insight,
      { id: "ins_2", meetingId: "mtg_1", kind: "RISK", text: "The freeze may block it" } as Insight,
    ],
    speakers: ["Priya", "Marcus"],
    ...over,
  };
}

describe("summary text", () => {
  it("is prose, not a document", () => {
    const text = summaryText(input());

    // What you paste into a reply: no headings, nothing to reformat.
    expect(text).toContain("We agreed to move billing to Stripe.");
    expect(text).not.toMatch(/^#/m);
    expect(text).not.toContain("ACTION ITEMS");
  });

  it("does not print the same paragraph twice", () => {
    const same = "One sentence.";
    const text = summaryText(
      input({
        summary: {
          shortSummary: same,
          detailedSummary: same,
          keyPoints: [],
        } as unknown as SummaryResponse,
      }),
    );

    expect(text).toBe(same);
  });

  it("is empty when there is no summary yet", () => {
    expect(summaryText(input({ summary: null }))).toBe("");
  });
});

describe("minutes, plain text", () => {
  it("reads as a document", () => {
    const text = minutesText(input());

    expect(text.startsWith("Sprint planning")).toBe(true);
    expect(text).toContain("Present: Priya, Marcus");
    expect(text).toContain("DECISIONS");
    expect(text).toContain("ACTION ITEMS");
    expect(text).toContain("RISKS AND BLOCKERS");
  });

  it("carries the owner and the date with the task", () => {
    // An action item without its owner is a task nobody has.
    expect(minutesText(input())).toContain("Draft the rollout plan (Marcus, due 2026-08-20)");
  });

  it("leaves out sections with nothing in them", () => {
    const text = minutesText(input({ insights: [], actionItems: [] }));

    // A pasted document is read once; blank headings read as an unfinished
    // draft rather than as "this never came up".
    expect(text).not.toContain("DECISIONS");
    expect(text).not.toContain("ACTION ITEMS");
    expect(text).toContain("SUMMARY");
  });

  it("prefers the template's own sections when there are any", () => {
    const text = minutesText(
      input({
        summary: {
          shortSummary: "ignored",
          keyPoints: [],
          sections: [
            { key: "risks", title: "Risks", kind: "bullets", bullets: ["Vendor lock-in"] },
            { key: "empty", title: "Budget", kind: "bullets", bullets: [] },
          ],
        } as unknown as SummaryResponse,
      }),
    );

    expect(text).toContain("RISKS");
    expect(text).toContain("Vendor lock-in");
    expect(text).not.toContain("BUDGET");
  });
});

describe("minutes, HTML", () => {
  it("uses headings and lists, which is what survives a paste", () => {
    const html = minutesHtml(input());

    expect(html).toContain("<h2");
    expect(html).toContain("<ul");
    expect(html).toContain("<li>");
    expect(html).toContain("<strong>Draft the rollout plan</strong>");
  });

  it("styles inline, because a stylesheet does not survive one", () => {
    expect(minutesHtml(input())).toContain('style="');
    expect(minutesHtml(input())).not.toContain("<style");
  });

  it("escapes text that would otherwise close a tag", () => {
    const html = minutesHtml(
      input({
        insights: [
          { id: "i", meetingId: "m", kind: "DECISION", text: 'Use <script>alert("x")</script>' } as Insight,
        ],
      }),
    );

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes the title too", () => {
    const html = minutesHtml(input({ meeting: { ...MEETING, title: "Q3 <b>plan</b>" } }));
    expect(html).toContain("Q3 &lt;b&gt;plan&lt;/b&gt;");
  });
});

describe("writing to the clipboard", () => {
  const write = vi.fn();
  const writeText = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    write.mockResolvedValue(undefined);
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write, writeText },
    });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(public items: Record<string, Blob>) {}
      },
    );
  });

  it("writes both flavours so each app gets what it can render", async () => {
    expect(await writeRich("<p>hi</p>", "hi")).toBe(true);

    // Only text and Gmail receives asterisks; only HTML and a plain editor
    // receives tag soup.
    expect(write).toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to plain text where ClipboardItem does not exist", async () => {
    vi.stubGlobal("ClipboardItem", undefined);

    expect(await writeRich("<p>hi</p>", "hi")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hi");
  });

  it("reports failure rather than pretending", async () => {
    write.mockRejectedValue(new Error("denied"));
    vi.stubGlobal("ClipboardItem", class {});

    // A copy that silently did nothing is worse than one that says so.
    expect(await writeRich("<p>hi</p>", "hi")).toBe(false);
  });

  it("copies the minutes as both flavours", async () => {
    expect(await copyMinutes(input())).toBe(true);
    expect(write).toHaveBeenCalled();
  });

  it("copies the summary as plain text only", async () => {
    expect(await copySummary(input())).toBe(true);

    // Prose has no formatting to preserve, and the HTML flavour would paste a
    // paragraph tag into someone's chat box.
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Stripe"));
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses to copy a summary that does not exist yet", async () => {
    expect(await copySummary(input({ summary: null }))).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});
