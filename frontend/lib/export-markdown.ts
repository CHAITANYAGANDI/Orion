/**
 * Markdown export for a meeting brief.
 *
 * The "Export" button previously called `window.print()`, which produces a PDF
 * and nothing else. Markdown is the format people actually want here: it pastes
 * into Notion, Obsidian, Linear, a doc or a commit message without reformatting.
 *
 * Pure functions, so the serialisation is testable without a DOM; only
 * `downloadMarkdown` touches the browser.
 */

import type {
  ActionItemResponse,
  DecisionResponse,
  MeetingResponse,
  RiskResponse,
  SummaryResponse,
  SummarySection,
  TranscriptSegment,
} from "@/lib/types";
import { timecode } from "@/lib/format";

export interface MeetingExport {
  meeting: MeetingResponse;
  summary?: SummaryResponse | null;
  decisions?: DecisionResponse[];
  actionItems?: ActionItemResponse[];
  risks?: RiskResponse[];
  segments?: TranscriptSegment[];
  includeTranscript?: boolean;
}

/**
 * A template's sections as markdown.
 *
 * Empty sections are kept, with a line saying so. The heading is information:
 * a "Budget" section with nothing under it tells the reader budget never came
 * up, whereas dropping it leaves them unable to tell that from a template that
 * never asked about budget at all.
 */
function sectionsToMarkdown(sections: SummarySection[]): string[] {
  const out: string[] = [];
  for (const s of sections) {
    out.push(`## ${s.title}`, "");
    if (s.kind === "prose") {
      out.push(s.text?.trim() || "_Not discussed._", "");
    } else if (s.kind === "bullets") {
      if (s.bullets.length) out.push(...s.bullets.map((b) => `- ${b}`));
      else out.push("_Not discussed._");
      out.push("");
    } else {
      if (!s.groups.length) out.push("_Not discussed._", "");
      for (const g of s.groups) {
        out.push(`### ${g.heading}`, "");
        out.push(...g.bullets.map((b) => `- ${b}`));
        out.push("");
      }
    }
  }
  return out;
}

export function toMarkdown(data: MeetingExport): string {
  const { meeting, summary, decisions, actionItems, risks, segments } = data;
  const out: string[] = [];

  out.push(`# ${meeting.title}`, "");

  const meta: string[] = [new Date(meeting.createdAt).toLocaleString()];
  if (meeting.durationSeconds) meta.push(formatLength(meeting.durationSeconds));
  if (meeting.participants?.length) meta.push(meeting.participants.join(", "));
  out.push(`*${meta.join(" · ")}*`, "");

  // A template-shaped summary exports as its own sections, which is both
  // better markdown and the only correct option: `detailedSummary` is a flat
  // rendering of those same sections, so emitting both would print the key
  // points twice and reduce the headings to plain lines.
  if (summary?.sections?.length) {
    out.push(...sectionsToMarkdown(summary.sections));
  } else {
    if (summary?.shortSummary) {
      out.push("## Summary", "", summary.shortSummary, "");
    }
    if (summary?.detailedSummary && summary.detailedSummary !== summary.shortSummary) {
      out.push(summary.detailedSummary, "");
    }
    if (summary?.keyPoints?.length) {
      out.push("## Key points", "");
      out.push(...summary.keyPoints.map((k) => `- ${k}`));
      out.push("");
    }
  }
  if (decisions?.length) {
    out.push("## Decisions", "");
    for (const d of decisions) {
      out.push(`- **${d.decision}**${d.confidence ? ` _(${d.confidence} confidence)_` : ""}`);
      if (d.sourceSentence) out.push(`  > ${d.sourceSentence}`);
    }
    out.push("");
  }
  if (actionItems?.length) {
    out.push("## Action items", "");
    for (const a of actionItems) {
      // GitHub-flavoured checkboxes: the export stays useful as a working list.
      const done = a.status === "DONE" ? "x" : " ";
      const bits = [a.ownerName, a.dueDate && `due ${a.dueDate}`, a.priority]
        .filter(Boolean)
        .join(" · ");
      out.push(`- [${done}] ${a.title}${bits ? ` — _${bits}_` : ""}`);
    }
    out.push("");
  }
  if (risks?.length) {
    out.push("## Risks", "");
    for (const r of risks) {
      out.push(`- **${r.risk}**${r.severity ? ` _(${r.severity})_` : ""}`);
      if (r.sourceSentence) out.push(`  > ${r.sourceSentence}`);
    }
    out.push("");
  }
  if (data.includeTranscript && segments?.length) {
    out.push("## Transcript", "");
    for (const s of segments) {
      out.push(`**[${timecode(s.start)}] ${s.speaker}:** ${s.text}`, "");
    }
  }

  out.push("---", "", "_Exported from Recallix AI_", "");
  return out.join("\n");
}

/** Filesystem-safe name derived from the meeting title. */
export function markdownFilename(title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "meeting";
  return `${slug}.md`;
}

export function downloadMarkdown(data: MeetingExport): void {
  const blob = new Blob([toMarkdown(data)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = markdownFilename(data.meeting.title);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function formatLength(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
