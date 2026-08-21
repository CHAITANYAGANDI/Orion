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
 * imports left — upgrade for unlimited" under this dropzone, and Recallix has
 * one free plan with nothing to upgrade to, so that line would be an
 * advertisement for a product that does not exist. The limit is real and is on
 * the Plans tab; a refusal, if one comes, arrives as the server's own sentence
 * rather than as a banner shown to everybody in advance.
 *
 * The language picker sets the account default rather than a per-file override,
 * and the copy says so. Recallix resolves the language once, when a meeting is
 * enqueued, from the account — there is no per-upload language in the pipeline,
 * so a control here that implied otherwise would silently do nothing to the
 * file being dropped.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UploadCloud, FileAudio, Loader2, X, Folder } from "lucide-react";
import {
  useGetProjectQuery,
  useCreateUploadUrlMutation,
  useCreateMeetingMutation,
  useGetLanguagesQuery,
  useGetPreferencesQuery,
  useUpdatePreferencesMutation,
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

  const [file, setFile] = React.useState<File | null>(null);
  const [duration, setDuration] = React.useState<number | null>(null);
  const [speakers, setSpeakers] = React.useState<SpeakerChoice>("auto");
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [progress, setProgress] = React.useState(0);
  const [dragging, setDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const busy = phase !== "idle";

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
      // No `recorded` flag: this file was captured somewhere Recallix was not,
      // which is what the imported-conversation email switch is about (V40).
      const meeting = await createMeeting({
        objectKey: presign.objectKey,
        contentType: file.type,
        durationSeconds: duration ?? undefined,
        projectId: projectId ?? undefined,
        // Absent unless somebody chose. See SPEAKER_CHOICES.
        ...speakerRange(speakers),
      }).unwrap();

      toast.success("Uploaded — processing started.");
      onOpenChange(false);
      reset();
      router.push(`/meetings/${meeting.id}`);
    } catch (err) {
      setPhase("idle");
      setProgress(0);
      // Left open, with the file still chosen: the commonest failure here is
      // the monthly limit, and closing the dialog would make the message
      // vanish along with the thing it was about.
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
            "flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 text-center transition-colors",
            dragging ? "border-primary bg-primary/5" : "border-input hover:border-primary/50",
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
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <FileAudio className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">
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
              <p className="text-lg font-semibold">Drag &amp; Drop</p>
              <UploadCloud className="mt-3 h-8 w-8 text-muted-foreground" />
              <p className="mt-3 text-xs text-muted-foreground">{COMMON_FORMATS}</p>
              <p className="mt-1 text-xs text-muted-foreground">
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

        <ExpectedSpeakers value={speakers} onChange={setSpeakers} disabled={busy} />
        <TranscriptLanguage disabled={busy} />

        {busy && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {phase === "uploading" ? "Uploading to storage…" : "Starting processing…"}
              </span>
              <span>{progress}%</span>
            </div>
            <Progress value={phase === "creating" ? 100 : progress} />
          </div>
        )}

        <Button className="w-full" disabled={busy || !file} onClick={() => void start()}>
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
 * How many voices to expect, or no opinion at all.
 *
 * <p>These reach AssemblyAI as **hard constraints**. An exact count makes
 * diarization find that many speakers whether or not that many spoke: tell it
 * two about a four-person call and two people are merged into one; tell it four
 * about a conversation and one person is split in half. That asymmetry is why
 * "I'm not sure" is the default, why it is offered first, and why nothing here
 * is inferred from a calendar — an invitation with four names is not four
 * speakers, because two of them were listening.
 *
 * <p>A range is the setting worth having and the reason this is not a number
 * box. People know roughly how many were in the room; almost nobody knows how
 * many of them will turn out to have spoken.
 */
type SpeakerChoice = "auto" | "1" | "2" | "3" | "2-4" | "5-10";

const SPEAKER_CHOICES: { value: SpeakerChoice; label: string }[] = [
  { value: "auto", label: "Work it out (recommended)" },
  { value: "1", label: "Just me" },
  { value: "2", label: "2 people" },
  { value: "3", label: "3 people" },
  { value: "2-4", label: "A small group (2-4)" },
  { value: "5-10", label: "A larger meeting (5-10)" },
];

/** The choice as request fields. Auto sends neither, which is the point. */
function speakerRange(choice: SpeakerChoice): {
  expectedSpeakersMin?: number;
  expectedSpeakersMax?: number;
} {
  if (choice === "auto") return {};
  const [low, high] = choice.split("-");
  const min = Number(low);
  const max = Number(high ?? low);
  return { expectedSpeakersMin: min, expectedSpeakersMax: max };
}

function ExpectedSpeakers({
  value,
  onChange,
  disabled,
}: {
  value: SpeakerChoice;
  onChange: (v: SpeakerChoice) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5 border-t pt-4">
      <label htmlFor="expected-speakers" className="text-sm font-medium">
        How many people are speaking?
      </label>
      <select
        id="expected-speakers"
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value as SpeakerChoice)}
        className="h-9 w-full rounded-md border bg-background px-3 text-sm disabled:opacity-50"
      >
        {SPEAKER_CHOICES.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">
        Optional. Saying so helps separate the speakers, but a wrong answer
        hurts — leave it on the first option if you are not sure.
      </p>
    </div>
  );
}

/**
 * The language transcription should assume.
 *
 * <p>An account setting shown at the point of use, and the wording is careful
 * about that: this does not apply to the file sitting in the dropzone above it.
 * The language is resolved when a meeting is enqueued and travels with the
 * Kafka event, so by the time anybody has dropped a file the decision for it is
 * already the account's. Saying "future transcripts" is the only honest way to
 * put a language picker on this dialog at all.
 */
function TranscriptLanguage({ disabled }: { disabled: boolean }) {
  const languages = useGetLanguagesQuery();
  const prefs = useGetPreferencesQuery();
  const [update] = useUpdatePreferencesMutation();

  const options = languages.data ?? [];

  async function save(code: string) {
    try {
      await update({ defaultLanguage: code }).unwrap();
      toast.success("Saved for future transcripts.");
    } catch (err) {
      toast.error(uploadError(err));
    }
  }

  return (
    <div className="space-y-1.5 border-t pt-4">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor="transcript-language" className="text-sm font-medium">
          Select transcript language
        </label>
        {options.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {options.length} languages supported
          </span>
        )}
      </div>
      <select
        id="transcript-language"
        disabled={disabled}
        value={prefs.data?.defaultLanguage ?? ""}
        onChange={(e) => void save(e.target.value)}
        className="h-9 w-full rounded-md border bg-background px-3 text-sm disabled:opacity-50"
      >
        <option value="">Detect automatically</option>
        {options.map((l) => (
          <option key={l.code} value={l.code}>
            {l.name}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">
        Applied to future transcripts, not to a file already dropped above. You
        can change it here or under Account Settings.
      </p>
    </div>
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
    <p className="flex items-center gap-1.5 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
      <Folder className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">
        Filing into <span className="font-medium text-foreground">{project.name}</span>
      </span>
    </p>
  );
}
