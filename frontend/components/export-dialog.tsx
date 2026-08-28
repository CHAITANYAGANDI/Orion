"use client";

/**
 * Taking a meeting out of Orion.
 *
 * <p>Two panes: what to take on the left, what it will look like on the right.
 * The preview is the reason the rest of it is worth building. Export used to be
 * one format picker and a transcript switch, and the question it could not
 * answer was the only one anybody actually has — *what am I about to get?* A
 * forty-page transcript and a two-page brief are the same button, and the
 * difference was discovered after the download.
 *
 * <p>Each part is its own file, which is why the button counts them. A summary
 * to paste into a reply and a transcript to search are not one document with a
 * heading between them; making them one was a limitation of having a single
 * endpoint, not a decision.
 *
 * <p>What a file <em>says</em> is still decided entirely by the server. The
 * preview here is a sketch of the text export and says so — the alternative is
 * two implementations of the same document that drift, which is exactly what
 * happened before when this component formatted anything itself.
 */

import * as React from "react";
import { toast } from "sonner";
import { Download, Loader2, Music, FileText, ListChecks } from "lucide-react";
import { useLazyGetAudioDownloadQuery } from "@/lib/api";
import {
  downloadExport,
  openSignedDownload,
  ExportError,
  type CombineMode,
  type ExportFormat,
} from "@/lib/exports";
import type { ActionItemResponse, SummaryResponse, TranscriptSegment } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { timecode } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The four document formats, in the order people want them. */
const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: "pdf", label: "PDF" },
  { value: "docx", label: "Word (docx)" },
  { value: "md", label: "Markdown" },
  { value: "txt", label: "Plain text (txt)" },
];

export interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: string;
  /** Drives the preview and the section list; the file itself is server-built. */
  summary?: SummaryResponse;
  actionItems?: ActionItemResponse[];
  segments?: TranscriptSegment[];
  /** How many utterances there are, so the transcript option can say so. */
  transcriptLines?: number;
  /** Set when the meeting is being read in a translation, so the file matches. */
  language?: string | null;
  languageName?: string | null;
  /** The language the meeting was actually held in, for the caveat. */
  sourceLanguageName?: string | null;
  /** False for meetings imported as documents, which never had a recording. */
  hasAudio?: boolean;
  /** What the recording actually is. There is no transcoding, so this is it. */
  audioContentType?: string | null;
}

export function ExportDialog({
  open,
  onOpenChange,
  meetingId,
  summary,
  actionItems = [],
  segments = [],
  transcriptLines = 0,
  language,
  languageName,
  sourceLanguageName,
  hasAudio = false,
  audioContentType,
}: ExportDialogProps) {
  const sections = summary?.sections ?? [];
  const hasTranscript = transcriptLines > 0;

  const [wantSummary, setWantSummary] = React.useState(true);
  const [summaryFormat, setSummaryFormat] = React.useState<ExportFormat>("txt");
  // Every section on by default, keyed rather than indexed so a resummarize
  // under an open dialog cannot silently reassign the ticks to other sections.
  const [chosen, setChosen] = React.useState<Set<string>>(new Set());
  const [wantActionItems, setWantActionItems] = React.useState(true);

  const [wantTranscript, setWantTranscript] = React.useState(false);
  const [transcriptFormat, setTranscriptFormat] = React.useState<ExportFormat>("txt");
  const [speakers, setSpeakers] = React.useState(true);
  const [timestamps, setTimestamps] = React.useState(true);
  const [combine, setCombine] = React.useState<CombineMode>("none");

  const [wantAudio, setWantAudio] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [fetchAudio] = useLazyGetAudioDownloadQuery();

  // Sections arrive after the dialog mounts, so this fills in rather than
  // seeding state: ticking everything at mount would tick an empty list.
  React.useEffect(() => {
    setChosen(new Set(sections.map((s) => s.key)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections.map((s) => s.key).join(",")]);

  const summaryParts =
    (chosen.size > 0 || sections.length === 0 ? 1 : 0) + (wantActionItems ? 1 : 0);
  const files =
    (wantSummary && summaryParts > 0 ? 1 : 0) +
    (wantTranscript && hasTranscript ? 1 : 0) +
    (wantAudio && hasAudio ? 1 : 0);

  function toggleSection(key: string) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function clearAll() {
    setWantSummary(false);
    setWantTranscript(false);
    setWantAudio(false);
  }

  async function onExport() {
    setBusy(true);
    try {
      // Sequential, and separate files. Firing them together makes the browser
      // discard all but one of the downloads on several platforms, which looks
      // exactly like an export that half worked.
      if (wantSummary && summaryParts > 0) {
        await downloadExport(meetingId, summaryFormat, {
          summary: true,
          // All of them is expressed by sending none, so a summary whose
          // sections have not loaded still exports in full.
          sections: chosen.size === sections.length ? [] : [...chosen],
          actionItems: wantActionItems,
          transcript: false,
          language,
        });
      }
      if (wantTranscript && hasTranscript) {
        await downloadExport(meetingId, transcriptFormat, {
          summary: false,
          actionItems: false,
          transcript: true,
          speakers,
          timestamps,
          combine,
          language,
        });
      }
      if (wantAudio && hasAudio) {
        const link = await fetchAudio(meetingId).unwrap();
        openSignedDownload(link.url);
      }
      onOpenChange(false);
    } catch (e) {
      // The server's sentence when it wrote one -- "this meeting has not been
      // translated into German" is the whole of what somebody needs. Never a
      // bare `e.message`, which for a dropped connection or a 500 is "Failed to
      // fetch" or "Download failed (500)": true, and no help to anyone.
      toast.error(e instanceof ExportError ? e.message : "Couldn't export this meeting.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={busy ? () => {} : onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Export</DialogTitle>
          <DialogDescription>
            {languageName
              ? `Written in ${languageName}, the language you are reading this in.`
              : "Choose what to take, and in which format."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 md:grid-cols-2">
          {/* ------------------------------ choices ---------------------- */}
          <div className="max-h-[24rem] space-y-5 overflow-y-auto pr-1">
            <p className="text-sm font-medium">Choose what to export</p>

            <Part
              label="Summary"
              on={wantSummary}
              onToggle={setWantSummary}
              format={summaryFormat}
              onFormat={setSummaryFormat}
            >
              {sections.length > 0 ? (
                sections.map((s) => (
                  <Check
                    key={s.key}
                    label={s.title}
                    checked={chosen.has(s.key)}
                    onChange={() => toggleSection(s.key)}
                  />
                ))
              ) : (
                /* Pre-template meetings have a flat brief with no sections to
                   pick from. Offering three invented tickboxes would imply a
                   structure their summary does not have. */
                <p className="text-xs text-muted-foreground">
                  This summary was written before templates, so it has no
                  sections to choose between.
                </p>
              )}
              <Check
                label="Action items"
                checked={wantActionItems}
                onChange={() => setWantActionItems((v) => !v)}
              />
            </Part>

            <Part
              label="Transcript"
              on={wantTranscript && hasTranscript}
              onToggle={setWantTranscript}
              disabled={!hasTranscript}
              disabledNote="There is no transcript for this meeting."
              format={transcriptFormat}
              onFormat={setTranscriptFormat}
            >
              <Check
                label="Show speaker names"
                checked={speakers}
                onChange={() => setSpeakers((v) => !v)}
              />
              <Check
                label="Show timestamps"
                checked={timestamps}
                onChange={() => setTimestamps((v) => !v)}
              />
              <Check
                label="Combine paragraphs of the same speaker"
                checked={combine === "speaker"}
                onChange={() => setCombine((c) => (c === "speaker" ? "none" : "speaker"))}
              />
              <Check
                label="Combine all paragraphs"
                checked={combine === "all"}
                onChange={() => setCombine((c) => (c === "all" ? "none" : "all"))}
              />
            </Part>

            {/* The recording, which is a different kind of thing from the four
                documents: not rendered, not small, and not fetched from the
                same place. No format choice, because there is no transcoding —
                what was uploaded is what comes back. */}
            <Part
              label="Audio"
              on={wantAudio && hasAudio}
              onToggle={setWantAudio}
              disabled={!hasAudio}
              disabledNote="This meeting has no stored recording."
              formatNote={audioLabel(audioContentType)}
            />
          </div>

          {/* ------------------------------ preview ---------------------- */}
          <div className="min-w-0">
            <Preview
              summary={summary}
              sections={chosen}
              actionItems={wantActionItems ? actionItems : []}
              segments={segments}
              speakers={speakers}
              timestamps={timestamps}
              combine={combine}
              showSummary={wantSummary}
              showTranscript={wantTranscript && hasTranscript}
            />
          </div>
        </div>

        {sourceLanguageName && languageName && (
          <p className="text-xs text-muted-foreground">
            The recording is in {sourceLanguageName}; this file is the
            translation, not a second transcription.
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <p className="text-sm text-muted-foreground">
            {files === 0
              ? "Nothing selected"
              : `${files} ${files === 1 ? "file" : "files"} to export`}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={clearAll} disabled={busy || files === 0}>
              Clear
            </Button>
            <Button onClick={() => void onExport()} disabled={busy || files === 0}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {busy ? "Exporting…" : "Export"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------- pieces -------------------------------- */

/** One switchable part of the export, with its format and its options. */
function Part({
  label,
  on,
  onToggle,
  disabled,
  disabledNote,
  format,
  onFormat,
  formatNote,
  children,
}: {
  label: string;
  on: boolean;
  onToggle: (v: boolean) => void;
  disabled?: boolean;
  disabledNote?: string;
  format?: ExportFormat;
  onFormat?: (f: ExportFormat) => void;
  formatNote?: string;
  children?: React.ReactNode;
}) {
  const id = `export-${label.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <section className="space-y-2 border-b pb-4 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className={cn("font-medium", disabled && "text-muted-foreground")}>
          {label}
        </label>
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={on}
          disabled={disabled}
          onChange={(e) => onToggle(e.target.checked)}
          className="h-4 w-8 shrink-0 cursor-pointer appearance-none rounded-full bg-muted transition-colors checked:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>

      {/* Said rather than implied. A switch that is simply off looks like a
          choice somebody made; one that cannot be turned on needs a reason. */}
      {disabled && disabledNote && (
        <p className="text-xs text-muted-foreground">{disabledNote}</p>
      )}

      {on && !disabled && (
        <div className="space-y-2 pl-1">
          {format && onFormat && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">File format</span>
              <select
                aria-label={`${label} file format`}
                value={format}
                onChange={(e) => onFormat(e.target.value as ExportFormat)}
                className="h-8 rounded-md border bg-background px-2 text-sm"
              >
                {FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {formatNote && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">File format</span>
              <span className="text-sm">{formatNote}</span>
            </div>
          )}
          {children && (
            <div className="space-y-1.5 pt-1">
              <p className="text-sm text-muted-foreground">Options</p>
              {children}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
      />
      <span>{label}</span>
    </label>
  );
}

/**
 * What the file will contain, near enough to decide by.
 *
 * <p>Explicitly a sketch of the plain-text export rather than a second
 * renderer. The server owns what a document says — four formats already agree
 * with each other because one place decides — and a pixel-accurate preview here
 * would be a fifth implementation that has to be kept in step with the other
 * four forever. What this has to get right is the shape and the order, because
 * that is what the choices on the left change.
 */
function Preview({
  summary,
  sections,
  actionItems,
  segments,
  speakers,
  timestamps,
  combine,
  showSummary,
  showTranscript,
}: {
  summary?: SummaryResponse;
  sections: Set<string>;
  actionItems: ActionItemResponse[];
  segments: TranscriptSegment[];
  speakers: boolean;
  timestamps: boolean;
  combine: CombineMode;
  showSummary: boolean;
  showTranscript: boolean;
}) {
  const [pane, setPane] = React.useState("summary");

  React.useEffect(() => {
    if (!showSummary && showTranscript) setPane("transcript");
    if (!showTranscript && showSummary) setPane("summary");
  }, [showSummary, showTranscript]);

  if (!showSummary && !showTranscript) {
    return (
      <div className="flex h-full min-h-[18rem] items-center justify-center rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        Nothing selected, so there is nothing to preview.
      </div>
    );
  }

  return (
    <Tabs value={pane} onValueChange={setPane}>
      <TabsList variant="underline" className="flex gap-x-6">
        {showSummary && <TabsTrigger value="summary">Summary</TabsTrigger>}
        {showTranscript && <TabsTrigger value="transcript">Transcript</TabsTrigger>}
      </TabsList>

      {showSummary && (
        <TabsContent value="summary">
          <Sheet>
            {(summary?.sections ?? [])
              .filter((s) => sections.has(s.key))
              .map((s) => (
                <div key={s.key} className="space-y-1">
                  <p className="font-semibold">{s.title}</p>
                  {s.kind === "prose" ? (
                    <p className="whitespace-pre-wrap">{s.text || "Not discussed."}</p>
                  ) : s.kind === "bullets" ? (
                    <Bullets items={s.bullets} />
                  ) : (
                    s.groups.map((g, i) => (
                      <div key={i} className="space-y-1">
                        <p className="font-medium">{g.heading}</p>
                        <Bullets items={g.bullets} />
                      </div>
                    ))
                  )}
                </div>
              ))}

            {actionItems.length > 0 && (
              <div className="space-y-1">
                <p className="flex items-center gap-1.5 font-semibold">
                  <ListChecks className="h-3.5 w-3.5" /> Action items
                </p>
                <Bullets items={actionItems.map((a) => a.title)} />
              </div>
            )}

            {(summary?.sections ?? []).filter((s) => sections.has(s.key)).length === 0 &&
              actionItems.length === 0 && (
                <p className="text-muted-foreground">
                  Every part of the summary is unticked, so this file would be
                  empty.
                </p>
              )}
          </Sheet>
        </TabsContent>
      )}

      {showTranscript && (
        <TabsContent value="transcript">
          <Sheet>
            {previewLines(segments, speakers, timestamps, combine).map((line, i) => (
              <div key={i} className="space-y-0.5">
                {line.label && <p className="font-medium">{line.label}</p>}
                <p className={cn(line.label && "pl-3")}>{line.text}</p>
              </div>
            ))}
            {segments.length === 0 && (
              <p className="flex items-center gap-2 text-muted-foreground">
                <FileText className="h-3.5 w-3.5" /> The transcript has not
                loaded yet — the file will still contain it.
              </p>
            )}
          </Sheet>
        </TabsContent>
      )}
    </Tabs>
  );
}

/** The first stretch of the transcript, laid out the way the options ask. */
export function previewLines(
  segments: TranscriptSegment[],
  speakers: boolean,
  timestamps: boolean,
  combine: CombineMode,
  limit = 40,
): { label: string; text: string }[] {
  const head = segments.slice(0, limit);
  if (head.length === 0) return [];

  const labelled = head.map((s) => ({
    speaker: speakers ? s.speaker || "Speaker" : "",
    time: timestamps ? timecode(s.start) : "",
    text: s.text ?? "",
  }));

  if (combine === "all") {
    // One block, and deliberately unattributed: naming it after whoever spoke
    // first would credit them with the whole meeting.
    return [{ label: "", text: labelled.map((l) => l.text).join(" ").trim() }];
  }

  const out: { label: string; text: string }[] = [];
  for (const line of labelled) {
    const label = [line.time && `[${line.time}]`, line.speaker].filter(Boolean).join(" ");
    const last = out[out.length - 1];
    // Merged on the printed label, so hiding names cannot quietly collapse the
    // whole transcript into one paragraph — that is the other option, chosen.
    if (combine === "speaker" && last && line.speaker && last.label === label) {
      last.text = `${last.text} ${line.text}`.trim();
      continue;
    }
    out.push({ label, text: line.text });
  }
  return out;
}

function Sheet({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-[20rem] space-y-3 overflow-y-auto rounded-md border bg-muted/30 p-4 text-xs leading-relaxed">
      {children}
    </div>
  );
}

function Bullets({ items }: { items: string[] }) {
  if (items.length === 0) return <p className="text-muted-foreground">Not discussed.</p>;
  return (
    <ul className="space-y-0.5">
      {items.map((b, i) => (
        <li key={i} className="flex gap-1.5">
          <span aria-hidden>-</span>
          <span>{b}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * What the recording actually is.
 *
 * <p>Read from the stored content type rather than printed as "mp3". Orion
 * does not transcode: a browser recording is webm, an iPhone upload is m4a, and
 * promising mp3 would name a file the user cannot play with the app they chose
 * it for.
 */
function audioLabel(contentType?: string | null): string {
  if (!contentType) return "original recording";
  const subtype = contentType.split("/")[1]?.split(";")[0] ?? "";
  if (!subtype) return "original recording";
  if (subtype.includes("mpeg")) return "mp3";
  if (subtype.includes("mp4")) return "m4a";
  return subtype;
}

/** Kept so the audio row has an icon to sit beside in future layouts. */
export const AUDIO_ICON = Music;
