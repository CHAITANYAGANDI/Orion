"use client";

/**
 * Getting a finished recording onto the server, and watching what happens next.
 *
 * <p>This used to live inside the docked control bar, which was fine while the
 * bar was the only thing that showed it. It is not any more: the record page
 * shows the same pipeline as a set of stages, and two components cannot own one
 * upload. So the state moved up to the provider, and both read it.
 *
 * <p>Two halves, one number. The upload is a real percentage from the browser;
 * everything after it is a stage reported by the worker. Showing them as two
 * bars — or one bar that fills, empties and fills again — reads as the first
 * half having been thrown away, so they share a scale. See {@link UPLOAD_SHARE}.
 *
 * <p>Saving leaves for Home immediately and the wait happens there, in the
 * docked bar. The recording page has nothing left to say at that point — the
 * audio is gone from the tab and the microphone is closed — so staying on it
 * would be sitting on a page about a recording that is over.
 *
 * <p>Finishing navigates nowhere. The bar goes and Home is already showing the
 * meeting in its list, which is where somebody would have gone looking anyway.
 * Being thrown onto the meeting page instead takes the choice away from anybody
 * who saved a recording and moved on to something else.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  api,
  useCreateUploadUrlMutation,
  useCreateMeetingMutation,
  useDeleteMeetingMutation,
  useGetMeetingQuery,
} from "@/lib/api";
import { useAppDispatch } from "@/lib/hooks";
import { subscribeMeetingStatus } from "@/lib/ws";
import { putWithProgress, uploadError } from "@/lib/uploads";
import { statusProgress } from "@/lib/format";
import type { MeetingStatus } from "@/lib/types";
import type { RecorderResult, UseRecorder } from "@/lib/use-recorder";

/** What the save is in the middle of. */
export type SavePhase = "idle" | "uploading" | "creating" | "processing" | "done" | "failed";

/** The meeting being processed, once there is one. */
export interface SaveJob {
  id: string;
  status: MeetingStatus;
  /** 0-100 from the worker, not from the upload. */
  progress: number;
  message: string;
}

/**
 * Where the upload ends and the pipeline begins, on one scale.
 *
 * <p>Roughly what the upload is worth on a domestic connection for an hour of
 * audio. Approximate on purpose: a number that only ever goes up is worth more
 * here than an accurate one.
 */
export const UPLOAD_SHARE = 0.3;

/** The stages, in the order they happen, for anything drawing them as steps. */
export const PIPELINE_STEPS = [
  { key: "upload", label: "Upload", hint: "Sending the audio to Recallix" },
  { key: "transcribe", label: "Transcribe", hint: "Turning speech into text" },
  { key: "summarise", label: "Summarise", hint: "Writing the brief" },
  { key: "extract", label: "Extract", hint: "Finding tasks, decisions and risks" },
] as const;

export type StepKey = (typeof PIPELINE_STEPS)[number]["key"];

/** Which step a phase and status are standing on. */
export function currentStep(phase: SavePhase, status?: MeetingStatus): StepKey | null {
  if (phase === "uploading" || phase === "creating") return "upload";
  if (phase === "idle") return null;
  switch (status) {
    case "CREATED":
    case "UPLOADED":
    case "QUEUED":
      return "upload";
    case "TRANSCRIBING":
      return "transcribe";
    case "SUMMARIZING":
      return "summarise";
    case "EXTRACTING":
      return "extract";
    default:
      return phase === "done" ? null : "transcribe";
  }
}

export interface UseSaveJob {
  phase: SavePhase;
  job: SaveJob | null;
  /** A save is in flight and the audio is still only in this tab. */
  busy: boolean;
  /** Something is running that a progress bar should be drawn for. */
  working: boolean;
  stopping: boolean;
  /** 0-100 across the upload and the pipeline together. */
  overallProgress: number;
  /** What to put beside that number. */
  label: string;
  save: (result: RecorderResult, title: string) => Promise<void>;
  stop: () => Promise<boolean>;
  dismiss: () => void;
}

export function useSaveJob(recorder: UseRecorder): UseSaveJob {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const [createUploadUrl] = useCreateUploadUrlMutation();
  const [createMeeting] = useCreateMeetingMutation();
  const [deleteMeeting] = useDeleteMeetingMutation();

  const [phase, setPhase] = React.useState<SavePhase>("idle");
  const [uploadProgress, setUploadProgress] = React.useState(0);
  const [job, setJob] = React.useState<SaveJob | null>(null);
  const [stopping, setStopping] = React.useState(false);

  const busy = phase === "uploading" || phase === "creating";
  const working = busy || phase === "processing";

  const clearPhase = React.useCallback(() => {
    setPhase("idle");
    setUploadProgress(0);
  }, []);

  const dismiss = React.useCallback(() => {
    setJob(null);
    setStopping(false);
    clearPhase();
  }, [clearPhase]);

  /**
   * A net under a bug worth naming.
   *
   * <p>`phase` outlives any one recording — the bar that reads it is mounted by
   * the shell and never unmounts, and this hook lives higher still. The save
   * path once reset it on failure and not on success, so a single saved
   * recording left the phase at "creating" for the life of the tab: the next
   * recording opened already "busy", with Discard not rendered and Save reading
   * "Working…" over a progress bar left at 100% from a different meeting.
   *
   * <p>Cleared explicitly on every terminal path now. This is the belt: with no
   * recording and no job there is nothing to be busy about, by definition.
   */
  React.useEffect(() => {
    if (recorder.state === "idle" && !job && phase !== "idle") clearPhase();
  }, [recorder.state, job, phase, clearPhase]);

  // Starting a new recording is the clearest possible statement that the last
  // one has been dealt with.
  React.useEffect(() => {
    if (recorder.state === "recording") dismiss();
  }, [recorder.state, dismiss]);

  const observe = React.useCallback(
    (status: MeetingStatus, progress: number, message: string) => {
      setJob((current) => (current ? { ...current, status, progress, message } : current));
      if (status === "READY") setPhase("done");
      else if (status === "FAILED") setPhase("failed");
    },
    [],
  );

  /**
   * Follow the pipeline by two routes.
   *
   * <p>The socket moves it a stage at a time. The poll is what makes it finish:
   * a browser or proxy that drops the WebSocket leaves the socket silent, and
   * relying on it alone gives a bar stuck on one number over a meeting that was
   * ready minutes ago.
   */
  const polled = useGetMeetingQuery(job?.id ?? "", {
    skip: !job || phase !== "processing",
    pollingInterval: 5000,
  });

  React.useEffect(() => {
    const meeting = polled.data;
    if (!meeting || phase !== "processing") return;
    observe(
      meeting.status,
      statusProgress(meeting.status),
      meeting.status === "FAILED"
        ? meeting.errorMessage || "Processing failed."
        : "Working…",
    );
  }, [polled.data, phase, observe]);

  const jobId = job?.id;
  React.useEffect(() => {
    if (!jobId || phase !== "processing") return;
    const sub = subscribeMeetingStatus(jobId, {
      onEvent: (e) => {
        if (e.meetingId !== jobId) return;
        observe(e.status, e.progress, e.message);
      },
    });
    return () => sub.deactivate();
  }, [jobId, phase, observe]);

  async function save(result: RecorderResult, title: string) {
    const { file, durationSeconds } = result;
    if (file.size === 0) {
      toast.error("That recording captured no audio, so there is nothing to save.");
      return;
    }
    try {
      setPhase("uploading");
      setUploadProgress(5);
      const presign = await createUploadUrl({
        filename: file.name,
        contentType: file.type,
        sizeBytes: file.size,
      }).unwrap();

      await putWithProgress(presign.uploadUrl, file, (pct) =>
        setUploadProgress(Math.max(5, pct)),
      );

      setPhase("creating");
      const meeting = await createMeeting({
        objectKey: presign.objectKey,
        title,
        contentType: file.type,
        durationSeconds: durationSeconds || undefined,
        // Not sent, deliberately: nobody is asked about consent any more, and
        // sending `true` would write a timestamp recording a statement nobody
        // made. Null is what "nobody said" looks like.
        recorded: true,
      }).unwrap();

      setJob({
        id: meeting.id,
        status: meeting.status ?? "QUEUED",
        progress: statusProgress(meeting.status ?? "QUEUED"),
        message: "Queued for processing…",
      });
      setPhase("processing");
      setUploadProgress(100);
      // The audio is on the server now. A second copy in the tab is one nothing
      // reads, and one the bar would go on offering to save.
      recorder.reset();
      // Off the recording page and back to the list. Everything left to happen
      // happens in the docked bar, which is on every page.
      router.push("/home");
    } catch (err) {
      clearPhase();
      toast.error(uploadError(err));
    }
  }

  /**
   * Stop, and take the meeting with it.
   *
   * <p>The worker is mid-flight and cannot be recalled, so this deletes what it
   * is working on instead. Its callbacks already handle a meeting that is no
   * longer there — `applyStatus` is an `ifPresent`, `applyResult` returns early
   * — so whatever arrives after this lands on nothing. The compute is spent
   * either way; what is being stopped is the meeting existing.
   */
  async function stop(): Promise<boolean> {
    if (!job) return false;
    setStopping(true);
    try {
      await deleteMeeting(job.id).unwrap();
      dismiss();
      toast.success("Stopped. The meeting and its recording were deleted.");
      return true;
    } catch {
      setStopping(false);
      toast.error("Couldn't stop that — it may have finished already.");
      return false;
    }
  }

  /**
   * Clear the bar, and say so once.
   *
   * <p>Guarded by id rather than by a boolean, because `settle` clears the very
   * phase this fires on — without the guard that clearing reads as a new state
   * and the whole thing runs a second time.
   *
   * <p>The cache invalidation is the part that is not cosmetic. The poll above
   * filled the meeting cache with the last thing it saw, which was
   * mid-pipeline; Home lists from that same cache, so the meeting would sit
   * there marked "Transcribing" until something else happened to refetch it.
   */
  const settled = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (phase !== "done" && phase !== "failed") return;
    const id = job?.id;
    if (!id || settled.current === id) return;
    settled.current = id;
    dispatch(api.util.invalidateTags([{ type: "Meeting", id }, "Meetings"]));
    // Nothing navigates, so this is the only thing that says the wait is over.
    if (phase === "failed") toast.error(job?.message || "Processing failed.");
    else toast.success("Your meeting is ready.");
    dismiss();
  }, [phase, job?.id, job?.message, dismiss, dispatch]);

  /**
   * One number for the whole wait, and it only ever goes up.
   *
   * <p>`done` is pinned to 100 rather than read from the last event: the worker
   * reports 100 on its final stage before the result lands, and a bar sitting
   * at 100% beside "Extracting…" is a finished job that is not.
   */
  const overallProgress =
    phase === "uploading"
      ? Math.round(uploadProgress * UPLOAD_SHARE)
      : phase === "creating"
        ? Math.round(100 * UPLOAD_SHARE)
        : phase === "processing"
          ? Math.min(
              99,
              Math.round(100 * UPLOAD_SHARE + (job?.progress ?? 0) * (1 - UPLOAD_SHARE)),
            )
          : phase === "done"
            ? 100
            : 0;

  const label =
    phase === "uploading"
      ? "Uploading the recording…"
      : phase === "creating"
        ? "Starting processing…"
        : job?.message || "Processing…";

  return {
    phase,
    job,
    busy,
    working,
    stopping,
    overallProgress,
    label,
    save,
    stop,
    dismiss,
  };
}
