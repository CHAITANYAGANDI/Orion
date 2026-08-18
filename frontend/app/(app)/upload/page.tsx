"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UploadCloud, FileAudio, Loader2, X, Mic } from "lucide-react";
import { useCreateUploadUrlMutation, useCreateMeetingMutation } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ProjectPicker } from "@/components/project-picker";
import {
  isImportable,
  probeDuration,
  putWithProgress,
  uploadError as errorMessage,
} from "@/lib/uploads";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

type Phase = "idle" | "uploading" | "creating";

export default function UploadPage() {
  const router = useRouter();
  const [createUploadUrl] = useCreateUploadUrlMutation();
  const [createMeeting] = useCreateMeetingMutation();

  const [file, setFile] = React.useState<File | null>(null);
  const [duration, setDuration] = React.useState<number | null>(null);
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [progress, setProgress] = React.useState(0);
  const [dragging, setDragging] = React.useState(false);
  const [projectId, setProjectId] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const busy = phase !== "idle";

  function onPick(f: File | null) {
    if (!f) return;
    if (!isImportable(f)) {
      toast.error("Please choose an audio or video file.");
      return;
    }
    setFile(f);
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
      // No title: the meeting is named after the file, and renamed on its own
      // page once there is something to name it after.
      const meeting = await createMeeting({
        objectKey: presign.objectKey,
        contentType: file.type,
        durationSeconds: duration ?? undefined,
        projectId: projectId ?? undefined,
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
        <h1 className="text-2xl font-bold tracking-tight">Add a meeting</h1>
        <p className="text-sm text-muted-foreground">
          Drop in an audio or video recording. Files go directly to private
          storage and processing starts automatically. The meeting takes its name
          from the file; rename and tag it afterwards.
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
                  <p className="text-xs text-muted-foreground">
                    MP3, WAV, M4A, MP4 — or any other audio or video file
                  </p>
                </>
              )}
            </div>

            {/* The one piece of metadata worth asking for before anyone has
                heard a word of it: whoever is uploading already knows which
                project this belongs to, and filing it later means going back
                through a list of things they have already dealt with. Renders
                nothing until there is a project to choose. */}
            <ProjectPicker
              value={projectId}
              onChange={setProjectId}
              disabled={busy}
              label="Project"
              className="h-9 text-sm"
            />

            {/* Live capture lives on its own page: it records the meeting tab as
                well as the microphone, which is the difference between capturing
                a meeting and capturing only your own half of it. */}
            <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-3 text-sm">
              <Mic className="h-4 w-4 shrink-0 text-primary" />
              <span className="text-muted-foreground">
                Meeting happening now?{" "}
                <Link href="/record" className="font-medium text-foreground underline underline-offset-2">
                  Record it live
                </Link>{" "}
                — captures the meeting tab plus your mic.
              </span>
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
