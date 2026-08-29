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
 * <p>What a file <em>says</em> is still decided entirely by the server. The
 * preview here is a sketch of the text export and says so — the alternative is
 * two implementations of the same document that drift, which is exactly what
 * happened before when this component formatted anything itself.
 *
 * <h2>What changed when export turned out to be unreliable</h2>
 *
 * <p>This component used to await the three parts in one `try`, save each blob
 * with its own synthetic click, and report every failure as "Couldn't export
 * this meeting." That produced three distinct user-visible bugs — a failed
 * summary cancelling the transcript, a second download the browser silently
 * refused, and a message that did not say which part went wrong. The mechanics
 * moved to `lib/export-run.ts` and `lib/exports.ts`, where they can be tested;
 * what is left here is the choosing, the waiting and the wording.
 *
 * <p>The dialog now stays open after any failure. Closing it was the old
 * behaviour and it threw away the selection, so retrying meant reconstructing
 * every tickbox from memory.
 */

import * as React from "react";
import { toast } from "sonner";
import { Download, Loader2, Music, FileText, ListChecks, AlertCircle } from "lucide-react";
import { useLazyGetAudioDownloadQuery, useLazyGetMp3ExportQuery } from "@/lib/api";
import {
  describeExportFailure,
  fetchExportFile,
  openSignedDownload,
  type CombineMode,
  type ExportFormat,
} from "@/lib/exports";
import { runExport, type DocumentRequest, type ExportFailure } from "@/lib/export-run";
import { linkIsFresh, prepareMp3, type Mp3Link } from "@/lib/mp3-export";
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
const FORMATS: { value: string; label: string }[] = [
  { value: "pdf", label: "PDF" },
  { value: "docx", label: "Word (docx)" },
  { value: "md", label: "Markdown" },
  { value: "txt", label: "Plain text (txt)" },
];

/** Which of the two things the recording can be handed over as. */
export type AudioFormat = "original" | "mp3";

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
  /** What the recording actually is, which is what "Original" will give you. */
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
  const [audioFormat, setAudioFormat] = React.useState<AudioFormat>("original");

  const [busy, setBusy] = React.useState(false);
  const [preparing, setPreparing] = React.useState(false);
  const [failures, setFailures] = React.useState<ExportFailure[]>([]);
  const [mp3Link, setMp3Link] = React.useState<Mp3Link | null>(null);

  /*
   * The duplicate-click guard, and it is a ref rather than the `busy` state on
   * purpose. `disabled={busy}` only takes effect after React has re-rendered,
   * so two clicks dispatched before that paint both pass — which on a slow
   * machine starts two conversions and two downloads. A ref is written
   * synchronously, in the handler, before the first `await`.
   */
  const running = React.useRef(false);
  // Read inside the export closure, which was created before the last link
  // arrived; state alone would give it a stale one.
  const heldMp3 = React.useRef<Mp3Link | null>(null);

  const [fetchAudio] = useLazyGetAudioDownloadQuery();
  const [fetchMp3] = useLazyGetMp3ExportQuery();

  // Sections arrive after the dialog mounts, so this fills in rather than
  // seeding state: ticking everything at mount would tick an empty list.
  React.useEffect(() => {
    setChosen(new Set(sections.map((s) => s.key)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections.map((s) => s.key).join(",")]);

  const summaryParts =
    (chosen.size > 0 || sections.length === 0 ? 1 : 0) + (wantActionItems ? 1 : 0);
  const documentCount =
    (wantSummary && summaryParts > 0 ? 1 : 0) + (wantTranscript && hasTranscript ? 1 : 0);
  const files = documentCount + (wantAudio && hasAudio ? 1 : 0);

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

  /**
   * A link to the recording as an MP3, waiting for the conversion if there is
   * one to wait for.
   *
   * <p>The held link is checked rather than trusted. It is signed and
   * short-lived, and the case it exists for — a second press after something
   * else failed — is exactly the case where enough time has passed for it to
   * have died. Asking again for a recording already converted costs a signature.
   */
  async function mp3(): Promise<Mp3Link> {
    const held = heldMp3.current;
    if (linkIsFresh(held, Date.now())) return held;
    setPreparing(true);
    try {
      const link = await prepareMp3(() => fetchMp3(meetingId).unwrap());
      heldMp3.current = link;
      setMp3Link(link);
      return link;
    } finally {
      setPreparing(false);
    }
  }

  async function deliverAudio() {
    if (audioFormat === "mp3") {
      openSignedDownload((await mp3()).url);
      return;
    }
    const link = await fetchAudio(meetingId).unwrap();
    openSignedDownload(link.url);
  }

  async function onExport() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setFailures([]);

    const documents: DocumentRequest[] = [];
    if (wantSummary && summaryParts > 0) {
      documents.push({
        part: "summary",
        fetch: () =>
          fetchExportFile(meetingId, summaryFormat, {
            summary: true,
            // All of them is expressed by sending none, so a summary whose
            // sections have not loaded still exports in full.
            sections: chosen.size === sections.length ? [] : [...chosen],
            actionItems: wantActionItems,
            transcript: false,
            language,
          }),
      });
    }
    if (wantTranscript && hasTranscript) {
      documents.push({
        part: "transcript",
        fetch: () =>
          fetchExportFile(meetingId, transcriptFormat, {
            summary: false,
            actionItems: false,
            transcript: true,
            speakers,
            timestamps,
            combine,
            language,
          }),
      });
    }

    try {
      const outcome = await runExport({
        documents,
        audio: wantAudio && hasAudio ? deliverAudio : undefined,
      });

      setFailures(outcome.failures);
      for (const failure of outcome.failures) {
        toast.error(failure.message);
      }
      if (outcome.complete) {
        onOpenChange(false);
      } else if (outcome.delivered.length > 0) {
        // Said explicitly, because the toast above is about what went wrong and
        // somebody who only reads that will assume nothing arrived.
        toast.success(
          `${outcome.delivered.length} of ${outcome.delivered.length + outcome.failures.length} downloaded.`,
        );
      }
    } catch (error) {
      /*
       * `runExport` handles every failure it expects, so reaching here means
       * something outside the parts went wrong. Caught anyway: an export that
       * throws silently, leaves the button re-enabled and says nothing is the
       * exact shape of the bug this whole change exists to remove.
       */
      const message = describeExportFailure("summary", error);
      setFailures([{ part: "summary", message }]);
      toast.error(message);
    } finally {
      running.current = false;
      setBusy(false);
      setPreparing(false);
    }
  }

  const audioChoices = [
    { value: "original", label: `Original (${audioLabel(audioContentType)})` },
    { value: "mp3", label: "MP3" },
  ];

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
              choiceLabel="File format"
              choices={FORMATS}
              choice={summaryFormat}
              onChoice={(v) => setSummaryFormat(v as ExportFormat)}
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
              choiceLabel="File format"
              choices={FORMATS}
              choice={transcriptFormat}
              onChoice={(v) => setTranscriptFormat(v as ExportFormat)}
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
                same place. Original hands over exactly what was uploaded; MP3
                is a real conversion, done once and kept, not a rename. */}
            <Part
              label="Audio"
              on={wantAudio && hasAudio}
              onToggle={setWantAudio}
              disabled={!hasAudio}
              disabledNote="This meeting has no stored recording."
              choiceLabel="Format"
              choices={audioChoices}
              choice={audioFormat}
              onChoice={(v) => setAudioFormat(v as AudioFormat)}
            >
              {audioFormat === "mp3" && !isAlreadyMp3(audioContentType) && (
                <p className="text-xs text-muted-foreground">
                  The recording will be converted the first time. After that it
                  is ready straight away.
                </p>
              )}
            </Part>
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

        {/* What went wrong, kept on screen. A toast is gone in five seconds and
            takes the only record of which part failed with it. */}
        {failures.length > 0 && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="space-y-1">
              {failures.map((failure) => (
                <p key={failure.part}>{failure.message}</p>
              ))}
              <p className="text-xs text-muted-foreground">
                Nothing else was affected. You can try again.
              </p>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <p className="text-sm text-muted-foreground">
            {files === 0
              ? "Nothing selected"
              : `${files} ${files === 1 ? "file" : "files"} to export${
                  documentCount > 1 ? ", bundled as one .zip" : ""
                }`}
          </p>
          <div className="flex items-center gap-2">
            {/* Offered after a conversion so the recording can be taken again
                without waiting, and without reopening the dialog. The link may
                have expired by the time it is pressed, which is why this goes
                back through the same freshness check. */}
            {mp3Link && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void mp3()
                    .then((link) => openSignedDownload(link.url))
                    // The link can have expired, and re-minting it can fail.
                    // An unhandled rejection here would be a button that does
                    // nothing and says nothing.
                    .catch((error) => toast.error(describeExportFailure("audio", error)))
                }
              >
                <Music className="h-4 w-4" />
                Download MP3
              </Button>
            )}
            <Button variant="ghost" onClick={clearAll} disabled={busy || files === 0}>
              Clear
            </Button>
            <Button
              onClick={() => void onExport()}
              disabled={busy || preparing || files === 0}
            >
              {busy || preparing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {preparing ? "Preparing MP3…" : busy ? "Exporting…" : "Export"}
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
  choiceLabel,
  choices,
  choice,
  onChoice,
  children,
}: {
  label: string;
  on: boolean;
  onToggle: (v: boolean) => void;
  disabled?: boolean;
  disabledNote?: string;
  choiceLabel?: string;
  choices?: { value: string; label: string }[];
  choice?: string;
  onChoice?: (value: string) => void;
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
          {choices && choice !== undefined && onChoice && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">{choiceLabel}</span>
              <select
                aria-label={`${label} ${(choiceLabel ?? "format").toLowerCase()}`}
                value={choice}
                onChange={(e) => onChoice(e.target.value)}
                className="h-8 rounded-md border bg-background px-2 text-sm"
              >
                {choices.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
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
 * <p>Read from the stored content type rather than guessed. It is what
 * "Original" will hand over — a browser recording is webm, an iPhone upload is
 * m4a — and naming it is the difference between choosing a format and finding
 * out afterwards.
 */
export function audioLabel(contentType?: string | null): string {
  if (!contentType) return "original recording";
  const subtype = contentType.split("/")[1]?.split(";")[0] ?? "";
  if (!subtype) return "original recording";
  if (subtype.includes("mpeg")) return "mp3";
  if (subtype.includes("mp4")) return "m4a";
  return subtype;
}

/** Whether choosing MP3 means a conversion or just a different link. */
function isAlreadyMp3(contentType?: string | null): boolean {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return type === "audio/mpeg" || type === "audio/mp3";
}

/** Kept so the audio row has an icon to sit beside in future layouts. */
export const AUDIO_ICON = Music;
