"use client";

/**
 * Import — the quick path, from the header.
 *
 * A file lands here far more often than anything else creates a meeting, and
 * before this it cost a page navigation away from whatever somebody was reading.
 * A dialog keeps them where they were: drop a file, watch it go, land on the
 * meeting when it is queued.
 *
 * What is deliberately absent is the quota upsell. Every product puts "3 of 3
 * imports left — upgrade for unlimited" under this dropzone, and Reverie has
 * one plan with nothing to upgrade to, so that line would be an advertisement
 * for a product that does not exist. Nothing is shown to somebody with room
 * left.
 *
 * A refusal, when there is one, is shown *here* rather than after the transfer.
 * That is a change: the limit used to be the server's alone, so a file was
 * uploaded in full and then rejected at the last step. The allowance is final
 * now — there is no reset date and nothing to buy — so spending somebody's
 * upload on an answer that was knowable before it started is simply waste. The
 * server still refuses; it just no longer has to.
 *
 * ## What this asked for and no longer does
 *
 * **A language.** It set the *account* default rather than anything about the
 * file being dropped — the language is resolved once, when a meeting is
 * enqueued — and the copy had to say so in two sentences to avoid lying. A
 * setting that cannot affect the thing you are looking at is a setting that
 * belongs on the settings page, which is where it still is: Account Settings
 * — General.
 *
 * **A speaker count.** Offered as a hint and sent to the provider as a hard
 * constraint, which is a poor trade to put in front of somebody who is halfway
 * through dropping a file: told two about a four-person call, diarization
 * merges two people into one. The default was "work it out", the recommendation
 * was to leave it there, and the honest version of a control whose best answer
 * is "don't touch it" is no control.
 *
 * The API still accepts `expectedSpeakersMin`/`Max`. Nothing sends them now.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { trackProcessing } from "@/lib/processing-jobs";
import { UploadCloud, FileAudio, Loader2, X, Folder } from "lucide-react";
import { useAllowance, importRefusal, lengthRefusal } from "@/lib/allowance";
import {
  useGetProjectQuery,
  useCreateUploadUrlMutation,
  useCreateMeetingMutation,
} from "@/lib/api";
import {
  COMMON_FORMATS,
  isImportable,
  probeDuration,
  putWithProgress,
  uploadError,
} from "@/lib/uploads";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

type Phase = "idle" | "uploading" | "creating";

export function ImportDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The folder this import lands in, or null for unfiled.
   *
   * Read from the page the dialog was opened over, not asked for here. Import
   * pressed inside a folder means "into this folder" — going and filing it
   * afterwards is a second trip through a list of things already dealt with,
   * which is exactly what the create endpoint's `projectId` exists to avoid.
   */
  projectId?: string | null;
}) {
  const router = useRouter();
  const [createUploadUrl] = useCreateUploadUrlMutation();
  const [createMeeting] = useCreateMeetingMutation();
  const allowance = useAllowance();

  const [file, setFile] = React.useState<File | null>(null);
  const [duration, setDuration] = React.useState<number | null>(null);
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [progress, setProgress] = React.useState(0);
  const [dragging, setDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const busy = phase !== "idle";

  // Two separate refusals, and the order matters: "you have no imports left" is
  // the wrong sentence for somebody who has imports but no minutes, and vice
  // versa. The length check only applies once a file has been chosen and
  // measured, and says nothing while the duration is still being probed.
  const blocked = importRefusal(allowance);
  const tooLong = blocked ? null : lengthRefusal(allowance, duration);
  const refusal = blocked ?? tooLong;

  function reset() {
    setFile(null);
    setDuration(null);
    setPhase("idle");
    setProgress(0);
    setDragging(false);
  }

  function onPick(f: File | null) {
    if (!f) return;
    if (!isImportable(f)) {
      toast.error("Please choose an audio or video file.");
      return;
    }
    setFile(f);
    void probeDuration(f).then(setDuration).catch(() => setDuration(null));
  }

  async function start() {
    if (!file) return;
    // Belt and braces with the disabled button: a dialog left open while the
    // last import was spent in another tab would otherwise present a live
    // control over a balance that is gone.
    if (refusal) {
      toast.error(refusal);
      return;
    }
    try {
      setPhase("uploading");
      setProgress(5);
      const presign = await createUploadUrl({
        filename: file.name,
        contentType: file.type,
        sizeBytes: file.size,
      }).unwrap();

      await putWithProgress(presign.uploadUrl, file, (pct) => setProgress(Math.max(5, pct)));

      setPhase("creating");
      // No `recorded` flag: this file was captured somewhere Reverie was not,
      // which is what the imported-conversation email switch is about (V40).
      const meeting = await createMeeting({
        objectKey: presign.objectKey,
        contentType: file.type,
        durationSeconds: duration ?? undefined,
        projectId: projectId ?? undefined,
      }).unwrap();

      // Watched from here on by the app-wide dock, so leaving this page --
      // or closing the dialog, which happens on the next line -- does not mean
      // the completion goes unnoticed. See lib/processing-jobs.
      trackProcessing(meeting.id);
      toast.success("Uploaded — processing started.");
      onOpenChange(false);
      reset();
      router.push(`/meetings/${meeting.id}`);
    } catch (err) {
      setPhase("idle");
      setProgress(0);
      // Left open, with the file still chosen. The allowance is checked before
      // the upload now, so what reaches here is a transfer that failed or a
      // balance that changed underneath it -- and closing the dialog would make
      // the message vanish along with the thing it was about.
      toast.error(uploadError(err));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A dialog closed mid-PUT would leave the upload running with nothing
        // reporting on it, so it stays put until the transfer resolves.
        if (busy) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Transcribe audio and video</DialogTitle>
          <DialogDescription>
            The file uploads straight to private storage and processing starts
            on its own. The meeting takes its name from the file.
          </DialogDescription>
        </DialogHeader>

        {/* Where it will end up, said before it goes rather than discovered
            afterwards. Filing silently is the same feature with none of the
            confidence: the difference between "it went where I meant" and
            "where has it gone". */}
        {projectId && <FilingInto projectId={projectId} />}

        <div
          role="button"
          tabIndex={0}
          onClick={() => !busy && inputRef.current?.click()}
          onKeyDown={(e) => {
            if (!busy && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            onPick(e.dataTransfer.files?.[0] ?? null);
          }}
          aria-label="Drag and drop a file, or browse"
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed p-8 text-center transition-colors duration-press ease-soft",
            // Brand while a file is over it, because that is Reverie about to
            // take something -- the one thing the accent means. A 2px dashed
            // border is a shape shouting at a target somebody is already aiming
            // for, so it is 1px.
            dragging
              ? "border-brand bg-brand/5"
              : "border-line hover:border-edge",
            busy && "pointer-events-none opacity-60",
          )}
        >
          <input
            ref={inputRef}
            type="file"
            accept="audio/*,video/*"
            className="hidden"
            onChange={(e) => onPick(e.target.files?.[0] ?? null)}
            data-testid="import-file-input"
          />

          {file ? (
            <div className="flex w-full items-center gap-3 text-left">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-surface-hover text-ink-2">
                <FileAudio className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-callout font-headline text-ink">{file.name}</p>
                {/* Both quantities mono and tabular. The size is read against
                    the allowance and the duration against the minutes left, so
                    they are figures rather than prose. */}
                <p className="tabular font-mono text-cap text-ink-4">
                  {(file.size / 1024 / 1024).toFixed(1)} MB
                  {duration ? ` · ${formatDuration(duration)}` : ""}
                </p>
              </div>
              {!busy && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Choose a different file"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFile(null);
                    setDuration(null);
                  }}
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          ) : (
            <>
              <UploadCloud className="h-8 w-8 text-ink-4" />
              <p className="mt-3 text-title-3 font-headline text-ink">Drag a file here</p>
              {/* The formats, and then the sentence that matters more: this
                  list is examples rather than a whitelist. Somebody with an
                  .m4a should not have to find it in a row of five chips. */}
              <p className="mt-2 font-mono text-cap uppercase text-ink-4">{COMMON_FORMATS}</p>
              <p className="mt-1 text-foot text-ink-3">
                or any other audio or video file
              </p>
              <span className="mt-4">
                <Button type="button" size="sm">
                  Browse files
                </Button>
              </span>
            </>
          )}
        </div>

        {busy && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-callout">
              <span className="text-ink-3">
                {phase === "uploading" ? "Uploading to storage…" : "Starting processing…"}
              </span>
              <span className="tabular font-mono text-ink-2">{progress}%</span>
            </div>
            <Progress value={phase === "creating" ? 100 : progress} />
          </div>
        )}

        {refusal && (
          <p className="v2-note py-1 text-callout text-ink-2" data-tone="warning">
            {refusal}
          </p>
        )}

        <Button
          className="w-full"
          disabled={busy || !file || refusal !== null}
          onClick={() => void start()}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <UploadCloud className="h-4 w-4" />
          )}
          {busy ? "Working…" : "Upload & process"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Which folder this import is going into.
 *
 * Named rather than assumed. The dialog is opened from a folder's own header,
 * so the destination is obvious in the moment and completely invisible an hour
 * later when somebody wonders where a file went — and a folder is exactly the
 * kind of thing people get wrong by one click. Falls back to the id's absence
 * rather than to a guess: while the name is loading there is nothing truthful
 * to put here.
 */
function FilingInto({ projectId }: { projectId: string }) {
  const { data: project } = useGetProjectQuery(projectId);
  if (!project) return null;

  return (
    /* Stated, never asked. Import pressed inside a folder means "into this
       folder" — the destination came from the press, and a picker here would
       ask the same question twice. What this does is make the answer visible
       before the file goes, which is the difference between "it went where I
       meant" and "where has it gone". */
    <p className="flex items-center gap-1.5 rounded-md border border-line bg-surface-raised px-3 py-2 text-callout text-ink-3">
      <Folder className="h-3.5 w-3.5 shrink-0 text-ink-4" />
      <span className="min-w-0">
        Filing into <span className="font-headline text-ink">{project.name}</span>
      </span>
    </p>
  );
}
