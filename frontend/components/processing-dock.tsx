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
import { usePathname } from "next/navigation";
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

/**
 * Which jobs this dock is allowed to draw, given where the user is standing.
 *
 * <p>One rule, and it is the whole reason this function exists: **the same
 * processing job must never draw two progress indicators in one view.**
 *
 * <ul>
 *   <li>On a meeting's own page, that meeting's inline banner is the statement
 *       — see components/processing-card — so the dock drops it. Other meetings
 *       still processing are not on screen anywhere else, so they stay.</li>
 *   <li>On Home, every processing meeting is already saying so inside its own
 *       row, so the dock draws nothing at all.</li>
 * </ul>
 *
 * <p>Exported for its own test: the rule is easier to get wrong than it looks,
 * and it is invisible in a screenshot of the case that works.
 */
export function visibleJobs(jobs: readonly string[], pathname: string): string[] {
  // Home lists them all with a bar in each row.
  if (pathname === "/home") return [];
  const onMeeting = /^\/meetings\/([^/]+)/.exec(pathname);
  const viewing = onMeeting?.[1];
  return jobs.filter((id) => id !== viewing);
}

/**
 * Watching and drawing are different things, and conflating them was a bug.
 *
 * <p>This used to `return null` when there was nothing to draw — on Home, and
 * for the meeting whose page was open. That did hide the duplicate bar, and it
 * also unmounted the watcher: no poll, no completion toast, and no cache
 * invalidation. So a meeting that finished while the user sat on Home was never
 * noticed, and its row went on saying "Processing" over a meeting that was
 * ready, until something unrelated happened to refetch the list.
 *
 * <p>Every tracked job is mounted now. `visible` decides only whether it puts
 * anything on screen.
 */
export function ProcessingDock() {
  const tracked = useProcessingJobs();
  // `?? ""` because `usePathname` is null during the first server pass, and a
  // dock that threw there would take the whole shell with it.
  const pathname = usePathname() ?? "";
  const shown = new Set(visibleJobs(tracked, pathname));
  if (tracked.length === 0) return null;

  return (
    /*
     * Above the recording bar's slot and out of the way of the page. Not
     * `pointer-events-none` on the wrapper with a re-enabled child, the way the
     * audio player does it: every pixel of this is either a link or a button, so
     * there is nothing to click through to.
     *
     * `empty:hidden` because the wrapper is mounted whenever anything is being
     * watched, including when every one of those is invisible here.
     */
    <div className="no-print fixed bottom-4 right-4 z-40 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 empty:hidden">
      {tracked.map((id) => (
        <JobCard key={id} meetingId={id} visible={shown.has(id)} />
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
function JobCard({ meetingId, visible }: { meetingId: string; visible: boolean }) {
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
  // Every hook above has run: this job is still watched, polled and settled
  // even where the bar is not wanted. Only the drawing is suppressed, and it is
  // suppressed exactly where another part of the page is already saying it.
  if (!visible) return null;

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
