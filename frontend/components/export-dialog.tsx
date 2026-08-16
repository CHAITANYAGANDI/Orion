"use client";

/**
 * Taking a meeting out of Recallix.
 *
 * <p>A dialog rather than four more items on the export menu, for two reasons.
 * The transcript is a choice worth making deliberately — it is the difference
 * between a two-page brief you attach to an email and a forty-page document
 * nobody opens — and it applies to every format, so it belongs beside them
 * rather than duplicated into each. And the recording is a different kind of
 * thing from the four documents: it is not rendered, it is not small, and it
 * does not come from the same place, so it gets its own section instead of
 * sitting in a list pretending to be a fifth format.
 *
 * <p>What the file says is decided by the server. This component decides only
 * what to ask for, which is why there is no formatting logic in it at all —
 * previously there was, and the markdown export and the PDF disagreed about
 * whether an empty section was worth keeping.
 */

import * as React from "react";
import { toast } from "sonner";
import { Download, FileText, FileType2, Hash, Loader2, Music } from "lucide-react";
import { useLazyGetAudioDownloadQuery } from "@/lib/api";
import { downloadExport, openSignedDownload, type ExportFormat } from "@/lib/exports";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface FormatChoice {
  value: ExportFormat;
  label: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
}

/**
 * The four, in the order people want them.
 *
 * PDF first because "send me the notes" almost always means a PDF; plain text
 * last because the people who want it know it is there.
 */
const FORMATS: FormatChoice[] = [
  { value: "pdf", label: "PDF", hint: "Send it to someone", icon: FileText },
  { value: "docx", label: "Word", hint: "Rewrite it as minutes", icon: FileType2 },
  { value: "md", label: "Markdown", hint: "Paste into Notion or Linear", icon: Hash },
  { value: "txt", label: "Plain text", hint: "Opens anywhere", icon: FileText },
];

export interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: string;
  /** How many utterances there are, so the transcript option can say so. */
  transcriptLines?: number;
  /** Set when the meeting is being read in a translation, so the file matches. */
  language?: string | null;
  languageName?: string | null;
  /** The language the meeting was actually held in, for the caveat. */
  sourceLanguageName?: string | null;
  /** False for meetings imported as documents, which never had a recording. */
  hasAudio?: boolean;
}

export function ExportDialog({
  open,
  onOpenChange,
  meetingId,
  transcriptLines = 0,
  language,
  languageName,
  sourceLanguageName,
  hasAudio = false,
}: ExportDialogProps) {
  const [format, setFormat] = React.useState<ExportFormat>("pdf");
  const [withTranscript, setWithTranscript] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [fetchAudio, { isFetching: fetchingAudio }] = useLazyGetAudioDownloadQuery();

  async function onDownload() {
    setBusy(true);
    try {
      await downloadExport(meetingId, format, {
        transcript: withTranscript && transcriptLines > 0,
        language,
      });
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not export this meeting.");
    } finally {
      setBusy(false);
    }
  }

  async function onDownloadAudio() {
    try {
      const link = await fetchAudio(meetingId).unwrap();
      openSignedDownload(link.url);
    } catch {
      toast.error("Could not get the recording.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Download this meeting</DialogTitle>
          <DialogDescription>
            The summary and the action items go in every format. The transcript is
            optional because it is most of the file.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="grid grid-cols-2 gap-2">
          <legend className="sr-only">Format</legend>
          {FORMATS.map((choice) => {
            const Icon = choice.icon;
            const selected = format === choice.value;
            return (
              <button
                key={choice.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setFormat(choice.value)}
                className={cn(
                  "flex items-start gap-3 rounded-md border p-3 text-left transition-colors",
                  selected
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-muted-foreground/40",
                )}
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{choice.label}</span>
                  <span className="block text-xs text-muted-foreground">{choice.hint}</span>
                </span>
              </button>
            );
          })}
        </fieldset>

        <label
          className={cn(
            "flex items-start gap-3 rounded-md border border-border p-3",
            transcriptLines === 0 && "opacity-50",
          )}
        >
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-primary"
            checked={withTranscript && transcriptLines > 0}
            disabled={transcriptLines === 0}
            onChange={(e) => setWithTranscript(e.target.checked)}
          />
          <span className="min-w-0 text-sm">
            <span className="block font-medium">Include the full transcript</span>
            <span className="block text-xs text-muted-foreground">
              {transcriptLines === 0
                ? "This meeting has no transcript."
                : `${transcriptLines.toLocaleString()} lines — everything that was said.`}
            </span>
          </span>
        </label>

        {language && (
          <p className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
            Written in {languageName ?? language}
            {sourceLanguageName
              ? `. The recording is still in ${sourceLanguageName}.`
              : ". The recording itself is unchanged."}
          </p>
        )}

        <div className="flex justify-end">
          <Button onClick={() => void onDownload()} disabled={busy} className="gap-2">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Download
          </Button>
        </div>

        {hasAudio && (
          <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
            <span className="flex items-start gap-3 text-sm">
              <Music className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span>
                <span className="block font-medium">The recording</span>
                <span className="block text-xs text-muted-foreground">
                  The original audio, exactly as it was uploaded.
                </span>
              </span>
            </span>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-2"
              onClick={() => void onDownloadAudio()}
              disabled={fetchingAudio}
            >
              {fetchingAudio ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              Audio
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
