"use client";

/**
 * Getting a finished recording onto the server, and watching what happens next.
 *
 * <p>Lives on the provider rather than in the control bar, because the thing
 * that reads it is not the bar: the meeting's own page draws the pipeline and
 * offers the one control that calls it off, and it is reached long after the
 * bar has gone.
 *
 * <p><b>Nothing here reports the upload any more.</b> There was a percentage,
 * drawn first in a docked bar and then in a modal that asked for the browser to
 * be kept open; both were removed on request. Against local storage the upload
 * is over in milliseconds, so what either of them actually produced was a flash
 * between pressing Save and the page changing. Save navigates straight away
 * now, and the wait somebody actually sits through is the pipeline — drawn in
 * the meeting's row on Home and as a banner on its own page. See
 * components/processing-row.tsx and components/processing-card.tsx.
 *
 * <p><b>Where it lands: Home.</b> It used to be `/meetings/<id>`, on the
 * reasoning that the wait belongs where the result will appear. The row on Home
 * says the same thing in a line, beside everything else there is to do
 * meanwhile, and does not make a screen out of waiting.
 *
 * <p><b>The phases past `creating` are still tracked</b>, and `processing` is
 * the one that earns its keep: it is what tells the meeting page that this is
 * the meeting being saved, and therefore the one whose pipeline can still be
 * stopped. `done` and `failed` now only put the phase back.
 *
 * <p><b>Announcing a finished meeting is no longer done here.</b> The toast and
 * the cache invalidation that stops Home listing a finished meeting as
 * "Transcribing" moved to `ProcessingDock`, which watches every processing
 * meeting rather than only the one this hook is holding — so a file somebody
 * imported got neither, and a recording got them only for as long as the tab
 * stayed on this hook's phase. What this hook still owes it is one call to
 * `trackProcessing` the moment the meeting exists.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  useCreateUploadUrlMutation,
  useCreateMeetingMutation,
  useDeleteMeetingMutation,
  useGetMeetingQuery,
} from "@/lib/api";
import { subscribeMeetingStatus } from "@/lib/ws";
import { putWithProgress, uploadError } from "@/lib/uploads";
import { HOME } from "@/lib/routes";
import { statusProgress } from "@/lib/format";
import { clampToStage } from "@/lib/progress";
import { trackProcessing, untrackProcessing } from "@/lib/processing-jobs";
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
  save: (
    result: RecorderResult,
    title: string,
    /** The folder to file it into, captured when Record was pressed. */
    projectId?: string | null,
  ) => Promise<void>;
  stop: () => Promise<boolean>;
  dismiss: () => void;
}

export function useSaveJob(recorder: UseRecorder): UseSaveJob {
  const router = useRouter();
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
      setJob((current) =>
        current
          ? {
              ...current,
              status,
              // The higher of the two, never simply the newer. The socket and
              // the poll below answer different questions — an event says how
              // far into a stage the worker is, a poll only which stage it is
              // in — so a poll landing between two events would otherwise walk
              // the number back to the stage floor. See lib/progress.
              progress: Math.max(current.progress, clampToStage(status, progress)),
              message,
            }
          : current,
      );
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

  /**
   * Upload what was recorded and make a meeting of it.
   *
   * `projectId` is where it gets filed, captured when Record was pressed rather
   * than read now — see `folderId` in lib/recording-context. Null is unfiled,
   * which is what recording from anywhere but inside a folder means.
   */
  async function save(result: RecorderResult, title: string, projectId?: string | null) {
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
        projectId: projectId ?? undefined,
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
      // Handed to the app-wide tracker, which is what settles the job when it
      // finishes -- the toast, and the refresh that stops Home listing a
      // finished meeting as still processing. This hook still follows the
      // pipeline -- the Stop control on the meeting page needs `job` -- but it
      // is no longer the only thing that does, so leaving this page no longer
      // means the completion goes unnoticed. See lib/processing-jobs.
      //
      trackProcessing(meeting.id);
      // The audio is on the server now. A second copy in the tab is one nothing
      // reads, and one the bar would go on offering to save.
      recorder.reset();
      // Back to the list, not onto the meeting.
      //
      // Saving used to land on `/meetings/<id>`, on the reasoning that the wait
      // should be watched where the result will appear. Home is the better
      // answer to the same question: the meeting is in the list from this
      // moment with its own row, its own stage and its own bar, and it is
      // beside everything else there is to do meanwhile. Opening a page that is
      // mostly placeholders makes the wait the subject again, which is the
      // thing this whole area has been moving away from.
      //
      // Nothing is lost by not going there. The row is a link, the completion
      // toast carries its own way in, and the pipeline never depended on a
      // browser being pointed at it.
      router.push(HOME);
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
      // Nothing left to watch. Without this the dock would poll a deleted
      // meeting until the 404 resolved, under a toast saying it was stopped.
      untrackProcessing(job.id);
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
   * Clear the bar when the pipeline settles.
   *
   * <p>Guarded by id rather than by a boolean, because `dismiss` clears the very
   * phase this fires on — without the guard that clearing reads as a new state
   * and the whole thing runs a second time.
   *
   * <p><b>It no longer announces anything.</b> The toast and the cache
   * invalidation moved to `ProcessingDock`, which watches every processing
   * meeting rather than only the one this hook is holding. Two owners meant an
   * imported file got neither — nothing tracked it — while a recording got both
   * twice over as soon as the dock existed. The dock is the one that survives
   * leaving the page, so the dock is the one that tells you.
   */
  const settled = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (phase !== "done" && phase !== "failed") return;
    const id = job?.id;
    if (!id || settled.current === id) return;
    settled.current = id;
    dismiss();
  }, [phase, job?.id, dismiss]);

  return { phase, job, busy, stopping, save, stop, dismiss };
}
