"use client";

/**
 * Record a live meeting from the browser.
 *
 * Two kinds of meeting, two capture modes. An online meeting mixes the meeting
 * tab's audio (the other participants) with your microphone; an in-person one
 * is the microphone alone, since everybody is already in the room. Either way
 * the result goes down the same presigned-upload → create-meeting path the
 * upload page uses, so processing is identical from there on.
 *
 * The recorder itself lives in the app shell rather than here, so navigating
 * away mid-meeting no longer destroys the recording. This page is a view onto
 * it: mount, unmount, come back, and a running recording is still running.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Mic,
  Square,
  Pause,
  Play,
  Loader2,
  UploadCloud,
  AlertTriangle,
  ShieldCheck,
  RotateCcw,
  Volume2,
  MonitorSpeaker,
  Users,
} from "lucide-react";
import { useCreateUploadUrlMutation, useCreateMeetingMutation } from "@/lib/api";
import { useRecording } from "@/lib/recording-context";
import type { CaptureMode } from "@/lib/use-recorder";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

type Phase = "idle" | "uploading" | "creating";

export default function RecordPage() {
  const router = useRouter();
  const recorder = useRecording();
  const [createUploadUrl] = useCreateUploadUrlMutation();
  const [createMeeting] = useCreateMeetingMutation();

  const [consented, setConsented] = React.useState(false);
  const [mode, setMode] = React.useState<CaptureMode>("online");
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [progress, setProgress] = React.useState(0);

  const busy = phase !== "idle";
  const live = recorder.state === "recording" || recorder.state === "paused";
  // Once a recording exists, the mode it was actually captured in is the truth.
  // The local picker only governs the *next* one — which matters when you come
  // back to this page mid-recording and local state has reset to its default.
  const effectiveMode: CaptureMode =
    live || recorder.state === "stopped" ? recorder.mode : mode;

  async function handleSave() {
    if (!recorder.result) return;
    const { file, durationSeconds } = recorder.result;
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
      // A title is sent here — unlike upload — because the recorder's filename
      // is `recording-1755084000000.webm`, which is not a name for anything.
      const meeting = await createMeeting({
        objectKey: presign.objectKey,
        title: defaultTitle(),
        contentType: file.type,
        durationSeconds: durationSeconds || undefined,
      }).unwrap();

      toast.success("Recording saved — processing started.");
      router.push(`/meetings/${meeting.id}`);
    } catch (err) {
      setPhase("idle");
      setProgress(0);
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Mic className="h-6 w-6 text-primary" /> Record a meeting
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Recording keeps running while you move around Recallix — the timer in
          the header follows you. Keep this browser tab open, though: closing or
          reloading it loses the audio.
        </p>
      </div>

      {!recorder.supported && (
        <Notice tone="error" icon={AlertTriangle}>
          This browser can&apos;t record audio.{" "}
          <Link href="/upload" className="underline underline-offset-2">
            Upload a file instead
          </Link>
          .
        </Notice>
      )}

      {/* Only the online path needs tab audio, which Safari and Firefox do not
          provide. In-person recording is plain getUserMedia and works
          everywhere, so this warning is scoped to the mode that suffers. */}
      {recorder.supported && effectiveMode === "online" && !live && (
        <p className="text-xs text-muted-foreground">
          Capturing tab audio needs Chrome or Edge — Safari and Firefox can only
          record your microphone. In-person recording works in any browser.
        </p>
      )}

      {/* Consent is a legal requirement in two-party-consent jurisdictions and
          under GDPR — not a nicety, so recording is gated on it. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-primary" /> Before you record
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Many places require everyone on a call to know it&apos;s being recorded,
            and some require their explicit agreement. Tell your participants
            before you start.
          </p>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={consented}
              disabled={live}
              onChange={(e) => setConsented(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
            />
            <span>
              I have informed everyone in this meeting that it is being recorded,
              and have their consent where required.
            </span>
          </label>
        </CardContent>
      </Card>

      {/* Capture mode. Locked once recording starts: the audio graph is built
          at start, so switching mid-recording would mean discarding what has
          been captured — which is never what someone reaching for this wants. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Where is everyone?</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <ModeOption
            icon={MonitorSpeaker}
            label="Online meeting"
            hint="Zoom, Meet or Teams in another tab. Records their audio and your mic."
            selected={effectiveMode === "online"}
            disabled={live || recorder.state === "requesting"}
            onSelect={() => setMode("online")}
          />
          <ModeOption
            icon={Users}
            label="In person"
            hint="Everyone's in the room. Records the microphone only — no screen sharing."
            selected={effectiveMode === "in-person"}
            disabled={live || recorder.state === "requesting"}
            onSelect={() => setMode("in-person")}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-5 py-6">
          {/* Recorder */}
          <div className="flex flex-col items-center gap-4 rounded-lg border bg-muted/30 py-8">
            <LevelRing level={recorder.level} active={recorder.state === "recording"} />

            <div className="text-center">
              <p className="font-mono text-3xl tabular-nums">
                {formatDuration(recorder.elapsed)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {recorder.state === "requesting"
                  ? "Waiting for permissions…"
                  : recorder.state === "recording"
                    ? "Recording"
                    : recorder.state === "paused"
                      ? "Paused"
                      : recorder.state === "stopped"
                        ? "Ready to save"
                        : "Not recording"}
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2">
              {recorder.state === "idle" && (
                <Button
                  onClick={() => void recorder.start(mode)}
                  disabled={!consented || !recorder.supported}
                  className="gap-2"
                >
                  <Mic className="h-4 w-4" />
                  {mode === "in-person" ? "Start recording the room" : "Start recording"}
                </Button>
              )}
              {recorder.state === "recording" && (
                <>
                  <Button variant="outline" onClick={recorder.pause} className="gap-2">
                    <Pause className="h-4 w-4" /> Pause
                  </Button>
                  <Button variant="destructive" onClick={recorder.stop} className="gap-2">
                    <Square className="h-4 w-4" /> Stop
                  </Button>
                </>
              )}
              {recorder.state === "paused" && (
                <>
                  <Button variant="outline" onClick={recorder.resume} className="gap-2">
                    <Play className="h-4 w-4" /> Resume
                  </Button>
                  <Button variant="destructive" onClick={recorder.stop} className="gap-2">
                    <Square className="h-4 w-4" /> Stop
                  </Button>
                </>
              )}
              {recorder.state === "stopped" && !busy && (
                <Button variant="outline" onClick={recorder.reset} className="gap-2">
                  <RotateCcw className="h-4 w-4" /> Discard & re-record
                </Button>
              )}
              {recorder.state === "requesting" && (
                <Button disabled className="gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> Requesting…
                </Button>
              )}
            </div>

            {!consented && recorder.state === "idle" && (
              <p className="text-xs text-muted-foreground">
                Confirm the notice above to enable recording.
              </p>
            )}
          </div>

          {recorder.error && (
            <Notice tone="error" icon={AlertTriangle}>
              {recorder.error}
            </Notice>
          )}

          {/* The single most common failure of the online path: user shared a
              window, or declined the share, so only their own voice was
              captured. In person that is the whole point, so warning about it
              would be telling someone their deliberate choice went wrong. */}
          {live && effectiveMode === "online" && !recorder.hasTabAudio && (
            <Notice tone="warn" icon={Volume2}>
              <strong>Microphone only.</strong> No tab audio is being captured, so
              other participants won&apos;t be recorded. Stop, start again, choose
              the <em>tab</em> running your meeting, and tick “Also share tab
              audio”. If everyone is in the room with you, switch to{" "}
              <strong>In person</strong> instead.
            </Notice>
          )}

          {recorder.state === "stopped" &&
            recorder.result &&
            recorder.result.mode === "online" &&
            !recorder.result.hadTabAudio && (
              <Notice tone="warn" icon={Volume2}>
                This recording contains your microphone only — other participants
                were not captured.
              </Notice>
            )}

          {/* Details, shown once there's something to save */}
          {recorder.state === "stopped" && recorder.result && (
            <div className="space-y-4">
              <div className="rounded-md border p-3 text-sm">
                <span className="font-medium">
                  {(recorder.result.file.size / 1024 / 1024).toFixed(1)} MB
                </span>{" "}
                <span className="text-muted-foreground">
                  · {formatDuration(recorder.result.durationSeconds)}
                  {recorder.result.mode === "in-person"
                    ? " · in-person (mic)"
                    : recorder.result.hadTabAudio
                      ? " · tab audio + mic"
                      : " · mic only"}
                </span>
              </div>

              {/* Saved as "Recording — <date>"; renamed on the meeting page,
                  where you can see what it turned out to be. Asking for a title
                  here means asking before the recording has been listened to. */}
              <p className="text-sm text-muted-foreground">
                Saves as <span className="text-foreground">{defaultTitle()}</span> — you
                can rename it on the meeting page.
              </p>

              {busy && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      {phase === "uploading" ? "Uploading…" : "Starting processing…"}
                    </span>
                    <span>{progress}%</span>
                  </div>
                  <Progress value={phase === "creating" ? 100 : progress} />
                </div>
              )}

              <Button onClick={handleSave} disabled={busy} className="w-full gap-2">
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <UploadCloud className="h-4 w-4" />
                )}
                {busy ? "Working…" : "Save & process"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-center text-xs text-muted-foreground">
        Already have a file?{" "}
        <Link href="/upload" className="underline underline-offset-2 hover:text-primary">
          Upload a recording instead
        </Link>
      </p>
    </div>
  );
}

/* --------------------------------- pieces -------------------------------- */

function ModeOption({
  icon: Icon,
  label,
  hint,
  selected,
  disabled,
  onSelect,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
        selected ? "border-primary bg-primary/5" : "hover:bg-accent",
        disabled && "cursor-not-allowed opacity-60 hover:bg-transparent"
      )}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", selected && "text-primary")} />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

function LevelRing({ level, active }: { level: number; active: boolean }) {
  const scale = 1 + (active ? level * 0.35 : 0);
  return (
    <div className="relative flex h-24 w-24 items-center justify-center">
      <div
        className={cn(
          "absolute inset-0 rounded-full transition-colors",
          active ? "bg-destructive/15" : "bg-muted"
        )}
        style={{ transform: `scale(${scale})`, transition: "transform 80ms linear" }}
      />
      <div
        className={cn(
          "relative flex h-16 w-16 items-center justify-center rounded-full",
          active ? "bg-destructive text-destructive-foreground" : "bg-muted-foreground/20"
        )}
      >
        <Mic className="h-6 w-6" />
      </div>
    </div>
  );
}

function Notice({
  tone,
  icon: Icon,
  children,
}: {
  tone: "warn" | "error";
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border p-3 text-sm",
        tone === "error"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

/* --------------------------------- helpers ------------------------------- */

function defaultTitle(): string {
  return `Recording — ${new Date().toLocaleString()}`;
}

function putWithProgress(
  url: string,
  file: File,
  onProgress: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed — network or CORS error"));
    xhr.send(file);
  });
}

function errorMessage(err: unknown): string {
  if (typeof err === "object" && err && "data" in err) {
    const data = (err as { data?: { message?: string } }).data;
    if (data?.message) return data.message;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong";
}
