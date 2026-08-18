import type {
  ActionItemResponse,
  Insight,
  MeetingResponse,
  SummaryResponse,
  SummarySection,
  TranscriptSegment,
} from "@/lib/types";
import { groupIntoTurns } from "@/lib/turns";
import { timecode } from "@/lib/format";

/**
 * Putting a meeting on the clipboard.
 *
 * <p>Two things, deliberately different. **Copy summary** is the paragraph you
 * paste into a reply — plain prose, no headings, nothing to reformat. **Copy
 * minutes** is the document you paste into a doc or an email: title, date,
 * attendees, decisions, actions with owners and dates.
 *
 * <p><b>Why the minutes are written twice.</b> The clipboard holds several
 * representations at once and the target app picks. Writing only text means
 * Gmail and Word receive markdown asterisks; writing only HTML means a plain
 * editor receives tag soup. Writing both means each gets what it can render,
 * which is the difference between "copy formatted minutes" and "copy some
 * characters that were formatted once".
 *
 * <p>Pure functions, so the serialisation is testable without a clipboard;
 * only {@link copyMinutes} and {@link copySummary} touch the browser.
 */

export interface MinutesInput {
  meeting: MeetingResponse;
  summary?: SummaryResponse | null;
  actionItems?: ActionItemResponse[];
  insights?: Insight[];
  /** Diarized speaker names, in order of appearance. */
  speakers?: string[];
}

/** Escapes text for the HTML flavour. Never trust a transcript with angle brackets. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function meetingDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function duration(seconds?: number | null): string {
  if (!seconds) return "";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The bullets of a template-shaped summary, flattened.
 *
 * A summary written to a template is sections; minutes are sections too, so the
 * headings carry straight over. Empty ones are dropped here — unlike the
 * markdown export, which keeps them because a file is a record and a heading
 * with nothing under it says the subject never came up. A pasted document is
 * something somebody reads once, and blank headings in it read as an unfinished
 * draft rather than as information.
 */
function usefulSections(sections: SummarySection[] | undefined): {
  title: string;
  lines: string[];
}[] {
  const out: { title: string; lines: string[] }[] = [];
  for (const s of sections ?? []) {
    if (s.kind === "prose") {
      if (s.text?.trim()) out.push({ title: s.title, lines: [s.text.trim()] });
    } else if (s.kind === "bullets") {
      if (s.bullets.length) out.push({ title: s.title, lines: [...s.bullets] });
    } else {
      const lines = s.groups.flatMap((g) => [`${g.heading}:`, ...g.bullets]);
      if (lines.length) out.push({ title: s.title, lines });
    }
  }
  return out;
}

/** One paragraph of prose — what "copy summary" puts on the clipboard. */
export function summaryText(input: MinutesInput): string {
  const { summary } = input;
  const parts: string[] = [];
  if (summary?.shortSummary?.trim()) parts.push(summary.shortSummary.trim());
  if (
    summary?.detailedSummary?.trim() &&
    summary.detailedSummary.trim() !== summary.shortSummary?.trim()
  ) {
    parts.push(summary.detailedSummary.trim());
  }
  if (summary?.keyPoints?.length) {
    parts.push(summary.keyPoints.map((k) => `• ${k}`).join("\n"));
  }
  return parts.join("\n\n");
}

function actionLine(a: ActionItemResponse): string {
  const bits = [a.ownerName, a.dueDate && `due ${a.dueDate}`].filter(Boolean).join(", ");
  return bits ? `${a.title} (${bits})` : a.title;
}

/** The plain-text flavour of the minutes. */
export function minutesText(input: MinutesInput): string {
  const { meeting, summary, actionItems, insights, speakers } = input;
  const out: string[] = [];

  out.push(meeting.title);
  const meta = [meetingDate(meeting.createdAt), duration(meeting.durationSeconds)].filter(Boolean);
  if (meta.length) out.push(meta.join(" · "));
  if (speakers?.length) out.push(`Present: ${speakers.join(", ")}`);
  out.push("");

  const sections = usefulSections(summary?.sections);
  if (sections.length) {
    for (const s of sections) {
      out.push(s.title.toUpperCase(), ...s.lines.map((l) => `  ${l}`), "");
    }
  } else {
    const prose = summaryText(input);
    if (prose) out.push("SUMMARY", prose, "");
  }

  const decisions = (insights ?? []).filter((i) => i.kind === "DECISION");
  if (decisions.length) {
    out.push("DECISIONS", ...decisions.map((d) => `  ${d.text}`), "");
  }

  if (actionItems?.length) {
    out.push("ACTION ITEMS", ...actionItems.map((a) => `  ${actionLine(a)}`), "");
  }

  const risks = (insights ?? []).filter((i) => i.kind === "RISK");
  if (risks.length) {
    out.push("RISKS AND BLOCKERS", ...risks.map((r) => `  ${r.text}`), "");
  }

  return out.join("\n").trimEnd();
}

/**
 * The HTML flavour — a document, not a styled page.
 *
 * Inline styles only, and few of them: pasting into Gmail or Word strips a
 * stylesheet, keeps inline attributes, and mangles anything clever. Headings,
 * lists and bold are what survives everywhere.
 */
export function minutesHtml(input: MinutesInput): string {
  const { meeting, summary, actionItems, insights, speakers } = input;
  const out: string[] = [];

  out.push(`<h2 style="margin:0 0 4px">${escapeHtml(meeting.title)}</h2>`);
  const meta = [meetingDate(meeting.createdAt), duration(meeting.durationSeconds)].filter(Boolean);
  if (meta.length) {
    out.push(`<p style="margin:0;color:#666">${escapeHtml(meta.join(" · "))}</p>`);
  }
  if (speakers?.length) {
    out.push(
      `<p style="margin:4px 0 0"><strong>Present:</strong> ${escapeHtml(speakers.join(", "))}</p>`,
    );
  }

  const heading = (text: string) =>
    out.push(`<h3 style="margin:16px 0 4px">${escapeHtml(text)}</h3>`);
  const list = (items: string[]) =>
    out.push(
      `<ul style="margin:0;padding-left:20px">${items
        .map((i) => `<li>${escapeHtml(i)}</li>`)
        .join("")}</ul>`,
    );

  const sections = usefulSections(summary?.sections);
  if (sections.length) {
    for (const s of sections) {
      heading(s.title);
      if (s.lines.length === 1) {
        out.push(`<p style="margin:0">${escapeHtml(s.lines[0])}</p>`);
      } else {
        list(s.lines);
      }
    }
  } else {
    if (summary?.shortSummary?.trim()) {
      heading("Summary");
      out.push(`<p style="margin:0">${escapeHtml(summary.shortSummary.trim())}</p>`);
    }
    if (summary?.keyPoints?.length) {
      heading("Key points");
      list(summary.keyPoints);
    }
  }

  const decisions = (insights ?? []).filter((i) => i.kind === "DECISION");
  if (decisions.length) {
    heading("Decisions");
    list(decisions.map((d) => d.text));
  }

  if (actionItems?.length) {
    heading("Action items");
    out.push(
      `<ul style="margin:0;padding-left:20px">${actionItems
        .map((a) => {
          const bits = [a.ownerName, a.dueDate && `due ${a.dueDate}`].filter(Boolean).join(", ");
          return `<li><strong>${escapeHtml(a.title)}</strong>${
            bits ? ` — ${escapeHtml(bits)}` : ""
          }</li>`;
        })
        .join("")}</ul>`,
    );
  }

  const risks = (insights ?? []).filter((i) => i.kind === "RISK");
  if (risks.length) {
    heading("Risks and blockers");
    list(risks.map((r) => r.text));
  }

  return out.join("");
}

/**
 * Write both flavours, falling back to plain text.
 *
 * `ClipboardItem` is what carries two representations at once and is not
 * everywhere — Firefox has only recently had it, and jsdom has none of this. The
 * fallback is not a degraded path worth warning about: plain text is what the
 * user asked for minus the styling, and a copy that silently did nothing would
 * be far worse than one that pasted unstyled.
 */
export async function writeRich(html: string, text: string): Promise<boolean> {
  try {
    const clipboard = navigator.clipboard;
    if (!clipboard) return false;
    if (typeof ClipboardItem !== "undefined" && clipboard.write) {
      await clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
      return true;
    }
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every word of a transcript, as plain text.
 *
 * <p>Grouped into turns and labelled `[00:12] Priya:`, which is the same shape
 * the page reads in and the same shape the export writes — a transcript pasted
 * into a ticket with different punctuation from the one in the file is two
 * documents claiming to be one.
 *
 * <p>Plain text only, unlike the minutes. A transcript is not a document
 * somebody formats; it is a body of words that goes into a search box, a
 * message, or another tool. Styling it would only give the paste target
 * something to strip.
 */
export function transcriptText(segments: TranscriptSegment[]): string {
  return groupIntoTurns(segments)
    .map((turn) => {
      const words = turn.segments.map((s) => s.text.trim()).filter(Boolean).join(" ");
      if (!words) return "";
      const who = turn.speaker?.trim();
      // A document has no speakers, so labelling every paragraph "Unknown
      // speaker" would add a column of noise to a transcript that never had
      // one. The timestamp is always true and always useful.
      const label = who ? `[${timecode(turn.start)}] ${who}:` : `[${timecode(turn.start)}]`;
      return `${label} ${words}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

export async function copyTranscript(segments: TranscriptSegment[]): Promise<boolean> {
  const text = transcriptText(segments);
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function copyMinutes(input: MinutesInput): Promise<boolean> {
  return writeRich(minutesHtml(input), minutesText(input));
}

export async function copySummary(input: MinutesInput): Promise<boolean> {
  const text = summaryText(input);
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
