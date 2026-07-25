"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UploadCloud, FileAudio, Loader2, X, Mic, Square } from "lucide-react";
import { useCreateUploadUrlMutation, useCreateMeetingMutation } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

type Phase = "idle" | "uploading" | "creating";

export default function UploadPage() {
  const router = useRouter();
  const [createUploadUrl] = useCreateUploadUrlMutation();
  const [createMeeting] = useCreateMeetingMutation();

  const [file, setFile] = React.useState<File | null>(null);
  const [title, setTitle] = React.useState("");
  const [participants, setParticipants] = React.useState("");
  const [tags, setTags] = React.useState("");
  const [duration, setDuration] = React.useState<number | null>(null);
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [progress, setProgress] = React.useState(0);
  const [dragging, setDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // In-browser recording (MediaRecorder).
  const [recording, setRecording] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const busy = phase !== "idle";

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error("Recording isn't supported in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = rec.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        const ext = type.includes("ogg") ? "ogg" : "webm";
        const recorded = new File([blob], `recording-${Date.now()}.${ext}`, { type });
        onPick(recorded);
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } catch {
      toast.error("Microphone access was denied.");
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    setRecording(false);
  }

  React.useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  function onPick(f: File | null) {
    if (!f) return;
    if (!/^(audio|video)\//.test(f.type)) {
      toast.error("Please choose an audio or video file.");
      return;
    }
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
    probeDuration(f).then(setDuration).catch(() => setDuration(null));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      toast.error("Choose a file first.");
      return;
    }
    try {
      // 1) presigned upload URL + meeting id
      setPhase("uploading");
      setProgress(5);
      const presign = await createUploadUrl({
        filename: file.name,
        contentType: file.type,
        sizeBytes: file.size,
      }).unwrap();

      // 2) direct PUT to storage with progress
      await putWithProgress(presign.uploadUrl, file, (pct) => setProgress(Math.max(5, pct)));

      // 3) confirm meeting -> enqueues processing
      setPhase("creating");
      const meeting = await createMeeting({
        objectKey: presign.objectKey,
        title: title.trim() || file.name,
        participants: splitList(participants),
        tags: splitList(tags),
        contentType: file.type,
        durationSeconds: duration ?? undefined,
      }).unwrap();

      toast.success("Uploaded — processing started.");
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
        <h1 className="text-2xl font-bold tracking-tight">Upload a meeting</h1>
        <p className="text-sm text-muted-foreground">
          Audio or video. It uploads directly to private storage, then processing starts automatically.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recording</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Dropzone */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => !busy && inputRef.current?.click()}
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
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 text-center transition-colors",
                dragging ? "border-primary bg-primary/5" : "border-input hover:border-primary/50",
                busy && "pointer-events-none opacity-60"
              )}
            >
              <input
                ref={inputRef}
                type="file"
                accept="audio/*,video/*"
                className="hidden"
                onChange={(e) => onPick(e.target.files?.[0] ?? null)}
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
                  <UploadCloud className="h-8 w-8 text-muted-foreground" />
                  <p className="mt-2 font-medium">Drop a file or click to browse</p>
                  <p className="text-xs text-muted-foreground">MP3, WAV, M4A, MP4 · up to your plan limit</p>
                </>
              )}
            </div>

            {/* Record in-browser */}
            <div className="flex items-center gap-3">
              {!recording ? (
                <Button type="button" variant="outline" size="sm" onClick={startRecording} disabled={busy}>
                  <Mic className="h-4 w-4" /> Record audio
                </Button>
              ) : (
                <Button type="button" variant="destructive" size="sm" onClick={stopRecording}>
                  <Square className="h-4 w-4" /> Stop
                </Button>
              )}
              {recording && (
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-destructive" />
                  Recording… {formatDuration(elapsed)}
                </span>
              )}
              <span className="text-xs text-muted-foreground">or attach a file above</span>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="title">Meeting title</Label>
              <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Sprint planning" disabled={busy} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="participants">Participants (comma-separated)</Label>
              <Input id="participants" value={participants} onChange={(e) => setParticipants(e.target.value)} placeholder="Alice, Bob" disabled={busy} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tags">Tags (comma-separated)</Label>
              <Input id="tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="sprint, planning" disabled={busy} />
            </div>

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

            <Button type="submit" className="w-full" disabled={busy || !file}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
              {busy ? "Working…" : "Upload & process"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function splitList(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const isVideo = file.type.startsWith("video/");
    const el = document.createElement(isVideo ? "video" : "audio");
    el.preload = "metadata";
    const url = URL.createObjectURL(file);
    el.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(el.duration) ? Math.round(el.duration) : null);
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    el.src = url;
  });
}

function putWithProgress(url: string, file: File, onProgress: (pct: number) => void): Promise<void> {
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
