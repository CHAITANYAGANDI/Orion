"use client";

/**
 * Getting a finished recording onto the server, and watching what happens next.
 *
 * <p>Lives on the provider rather than in the control bar, because the thing
 * that reads it is not the bar: saving lands on the meeting's own page, and
 * that page draws the pipeline and offers the one control that calls it off.
 *
 * <p><b>Nothing here reports the upload any more.</b> There was a percentage,
 * drawn first in a docked bar and then in a modal that asked for the browser to
 * be kept open; both were removed on request. Against local storage the upload
 * is over in milliseconds, so what either of them actually produced was a flash
 * between pressing Save and arriving at the meeting. Save goes straight there
 * now, and the wait somebody actually sits through is the pipeline, drawn full
 * width on the page they land on. See components/processing-card.tsx.
 *
 * <p><b>The phases past `creating` are still tracked</b>, and they are not
 * decoration. `processing` is what tells the meeting page that this is the
 * meeting being saved, and therefore the one whose pipeline can still be
 * stopped; `done` and `failed` are what invalidate the caches Home lists from,
 * so a finished meeting stops reading "Processing" in a list nobody refetched.
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

export interface UseSaveJob {
  phase: SavePhase;
  job: SaveJob | null;
  /**
   * A save is in flight and the audio is still only in this tab.
   *
   * <p>Read by the bar, which stands down for exactly this stretch. Not a
   * percentage and not a label: what it answers is whether there is anything
   * to draw, and the answer is no.
   */
  busy: boolean;
  stopping: boolean;
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
  const [job, setJob] = React.useState<SaveJob | null>(null);
  const [stopping, setStopping] = React.useState(false);

  const busy = phase === "uploading" || phase === "creating";

  const clearPhase = React.useCallback(() => setPhase("idle"), []);

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
      const presign = await createUploadUrl({
        filename: file.name,
        contentType: file.type,
        sizeBytes: file.size,
      }).unwrap();

      // The progress callback goes nowhere on purpose. `putWithProgress` is
      // still what performs the PUT -- it is the XHR that can report at all --
      // and there is nothing left on screen to tell.
      await putWithProgress(presign.uploadUrl, file, () => {});

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
      // The audio is on the server now. A second copy in the tab is one nothing
      // reads, and one the bar would go on offering to save.
      recorder.reset();
      // Onto the meeting that was just made. It exists from this moment, it has
      // a page, and that page already draws the pipeline full width with the
      // stage it is on — so the wait is watched in the place the result will
      // appear rather than in a bar over a list the meeting is not in yet.
      // Leaving is still free: the bar picks the wait up on any other page.
      router.push(`/meetings/${meeting.id}`);
    } catch (err) {
      // The recorder was not reset, so the audio is still in the tab and the
      // bar comes back offering Save. The toast is the whole of the telling.
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

  return { phase, job, busy, stopping, save, stop, dismiss };
}
