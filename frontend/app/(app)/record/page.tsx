"use client";

/**
 * Record a live meeting from the browser.
 *
 * Captures the meeting tab's audio (the other participants) mixed with your
 * microphone, then hands the result to the same presigned-upload → create-meeting
 * path the upload page uses, so processing is identical from there on.
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
} from "lucide-react";
import { useCreateUploadUrlMutation, useCreateMeetingMutation } from "@/lib/api";
import { useRecorder } from "@/lib/use-recorder";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

type Phase = "idle" | "uploading" | "creating";

export default function RecordPage() {
  const router = useRouter();
  const recorder = useRecorder();
  const [createUploadUrl] = useCreateUploadUrlMutation();
  const [createMeeting] = useCreateMeetingMutation();

  const [consented, setConsented] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [participants, setParticipants] = React.useState("");
  const [tags, setTags] = React.useState("");
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [progress, setProgress] = React.useState(0);

  const busy = phase !== "idle";
  const live = recorder.state === "recording" || recorder.state === "paused";

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
      const meeting = await createMeeting({
        objectKey: presign.objectKey,
        title: title.trim() || defaultTitle(),
        participants: splitList(participants),
        tags: splitList(tags),
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
          Captures the meeting tab plus your microphone. Keep this tab open while
          you record — you can switch windows, just don&apos;t close it.
        </p>
      </div>

      {!recorder.supported && (
        <Notice tone="error" icon={AlertTriangle}>
          This browser can&apos;t record audio. Chrome or Edge support capturing tab
          audio; Safari and Firefox don&apos;t.{" "}
          <Link href="/upload" className="underline underline-offset-2">
            Upload a file instead
          </Link>
          .
        </Notice>
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
                  onClick={() => void recorder.start()}
                  disabled={!consented || !recorder.supported}
                  className="gap-2"
                >
                  <Mic className="h-4 w-4" /> Start recording
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

          {/* The single most common failure: user shared a window, or declined
              the share, so only their own voice was captured. */}
          {live && !recorder.hasTabAudio && (
            <Notice tone="warn" icon={Volume2}>
              <strong>Microphone only.</strong> No tab audio is being captured, so
              other participants won&apos;t be recorded. Stop, start again, choose
              the <em>tab</em> running your meeting, and tick “Also share tab
              audio”.
            </Notice>
          )}

          {recorder.state === "stopped" && recorder.result && !recorder.result.hadTabAudio && (
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
                  {recorder.result.hadTabAudio ? " · tab audio + mic" : " · mic only"}
                </span>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="title">Meeting title</Label>
                <Input
                  id="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={defaultTitle()}
                  disabled={busy}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="participants">Participants (comma-separated)</Label>
                <Input
                  id="participants"
                  value={participants}
                  onChange={(e) => setParticipants(e.target.value)}
                  placeholder="Alice, Bob"
                  disabled={busy}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="tags">Tags (comma-separated)</Label>
                <Input
                  id="tags"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="sprint, planning"
                  disabled={busy}
                />
              </div>

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

function splitList(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
