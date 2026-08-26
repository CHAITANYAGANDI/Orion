"use client";

/**
 * The wait, following you around instead of holding you in one place.
 *
 * <p>Rendered by the shell, so it survives every in-app navigation — which is
 * the whole point. Processing has always been a background job: the ai-service
 * consumes from Kafka and never checks whether a browser is open, and closing
 * the tab has never stopped a meeting being transcribed. It was only the
 * interface that implied otherwise, by turning the meeting's page into a
 * full-width progress card and rendering nothing else until it finished.
 *
 * <p>Now the page keeps a slim banner and this carries the job everywhere else.
 * Clicking it opens the meeting; dismissing it stops watching without stopping
 * anything on the server, which is the honest thing for a control that cannot
 * recall a worker mid-flight.
 *
 * <p><b>One watcher per meeting, and it lives here.</b> Completion — the toast,
 * the cache invalidation that stops Home listing a finished meeting as
 * "Transcribing" — used to be `useSaveJob`'s job, which meant it only happened
 * for recordings and only while that hook's phase was still `processing`. An
 * import got neither. Both now happen here for every tracked meeting, whatever
 * created it.
 */

import * as React from "react";
import Link from "next/link";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { api, useGetMeetingQuery } from "@/lib/api";
import { useAppDispatch } from "@/lib/hooks";
import { useProcessingJobs, untrackProcessing } from "@/lib/processing-jobs";
import { subscribeMeetingStatus } from "@/lib/ws";
import { statusLabel, statusProgress, isTerminal } from "@/lib/format";
import { useMeetingProgress } from "@/lib/progress";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import type { MeetingStatus } from "@/lib/types";

export function ProcessingDock() {
  const jobs = useProcessingJobs();
  if (jobs.length === 0) return null;

  return (
    /*
     * Above the recording bar's slot and out of the way of the page. Not
     * `pointer-events-none` on the wrapper with a re-enabled child, the way the
     * audio player does it: every pixel of this is either a link or a button, so
     * there is nothing to click through to.
     */
    <div className="no-print fixed bottom-4 right-4 z-40 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2">
      {jobs.map((id) => (
        <JobCard key={id} meetingId={id} />
      ))}
    </div>
  );
}

/**
 * One meeting being watched.
 *
 * <p>A component per job rather than a loop inside one, because each needs its
 * own query, its own socket subscription and its own progress clock — and hooks
 * cannot be called in a loop over a list that changes length.
 */
function JobCard({ meetingId }: { meetingId: string }) {
  const dispatch = useAppDispatch();
  const [live, setLive] = React.useState<{ status: MeetingStatus; progress: number } | null>(null);

  /*
   * Two routes to the same answer, for the same reason `useSaveJob` had both:
   * the socket moves a stage at a time and is the responsive one, and the poll
   * is what makes it finish. A browser or proxy that drops the WebSocket leaves
   * the socket silent, and a dock that trusted it alone would sit at one number
   * over a meeting that was ready ten minutes ago.
   */
  const { data } = useGetMeetingQuery(meetingId, { pollingInterval: 5000 });

  React.useEffect(() => {
    const sub = subscribeMeetingStatus(meetingId, {
      onEvent: (e) => {
        if (e.meetingId !== meetingId) return;
        setLive({ status: e.status as MeetingStatus, progress: e.progress });
      },
    });
    return () => sub.deactivate();
  }, [meetingId]);

  const status: MeetingStatus = (live?.status ?? data?.status ?? "QUEUED") as MeetingStatus;
  const percent = useMeetingProgress(meetingId, status, live?.progress ?? statusProgress(status));
  const done = isTerminal(status);

  /*
   * Settle once, then stop watching.
   *
   * Guarded by a ref rather than by `done`, because untracking unmounts this
   * component — so without the guard a re-render in the same tick could fire
   * the toast twice, and the invalidation is what stops Home showing a finished
   * meeting as still processing.
   */
  const settled = React.useRef(false);
  React.useEffect(() => {
    if (!done || settled.current) return;
    settled.current = true;
    dispatch(api.util.invalidateTags([{ type: "Meeting", id: meetingId }, "Meetings"]));
    const title = data?.title?.trim();
    if (status === "FAILED") {
      toast.error(
        title ? `Processing failed for "${title}".` : "Processing failed.",
        { description: data?.errorMessage || undefined },
      );
    } else {
      toast.success(title ? `"${title}" is ready.` : "Your meeting is ready.", {
        // The whole reason the toast is worth having: it arrives while you are
        // somewhere else, so it has to carry the way back.
        action: { label: "Open", onClick: () => { window.location.href = `/meetings/${meetingId}`; } },
      });
    }
    untrackProcessing(meetingId);
  }, [done, status, meetingId, data?.title, data?.errorMessage, dispatch]);

  // Gone from the list on the next commit; drawing a finished bar for that
  // frame would flash "100% Ready" under a toast that already said so.
  if (done) return null;

  return (
    <div className="rounded-lg border bg-card p-3 shadow-lg">
      <div className="flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        <Link
          href={`/meetings/${meetingId}`}
          className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
        >
          {data?.title?.trim() || "Your recording"}
        </Link>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {Math.round(percent)}%
        </span>
        {/* Stops watching, and says so. It cannot stop the worker — that is
            what deleting the meeting does, and it is offered on the meeting's
            own page where the consequence can be spelled out. */}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground"
          aria-label="Stop showing this"
          onClick={() => untrackProcessing(meetingId)}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <Progress value={Math.round(percent)} className="mt-2 h-1" />
      <p className="mt-1.5 text-xs text-muted-foreground">
        {statusLabel(status)} — this keeps going if you leave.
      </p>
    </div>
  );
}
