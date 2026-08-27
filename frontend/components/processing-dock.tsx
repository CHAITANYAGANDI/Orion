"use client";

/**
 * Following every meeting this tab is watching, and drawing nothing at all.
 *
 * <p><b>There is no docked bar any more.</b> There was one — a small card in
 * the bottom-right corner with a title, a percentage and a dismiss button, on
 * the reasoning that a background job should be visible from wherever you
 * happened to be. It was removed on request, and the request was right: a
 * meeting being processed is already stated in its own row on Home and in the
 * banner on its own page, so the card was a third copy of the same fact,
 * floating over whatever was actually being read. It also outlived its welcome
 * badly — a job that never reached a terminal status sat in the corner of every
 * page for the life of the tab, including over a *new* recording in progress.
 *
 * <p><b>What is left is the part nothing else does.</b> Completion — the "your
 * meeting is ready" toast, and the cache invalidation that stops Home listing a
 * finished meeting as still processing — has to be owned by something mounted
 * on every route, or it only happens when you are already looking at the
 * meeting. That used to be `useSaveJob`, which meant it fired for recordings
 * and never for imports. It is this, and it renders nothing.
 *
 * <p>So the component stays where it was in the shell and keeps its name in the
 * import list; what it does is subscribe, poll, settle and get out of the way.
 * Watching and drawing were always separate concerns here — see the history in
 * lib/processing-jobs — and this is that separation taken to its end.
 */

import * as React from "react";
import { toast } from "sonner";
import { api, useGetMeetingQuery } from "@/lib/api";
import { useAppDispatch } from "@/lib/hooks";
import { useProcessingJobs, untrackProcessing } from "@/lib/processing-jobs";
import { subscribeMeetingStatus } from "@/lib/ws";
import { isTerminal } from "@/lib/format";
import type { MeetingStatus } from "@/lib/types";

export function ProcessingDock() {
  const tracked = useProcessingJobs();

  // No wrapper element. There is nothing to lay out, and an empty positioned
  // div in the corner of every page in the app is exactly the sort of thing
  // that turns into a stray click target nobody can find.
  return (
    <>
      {tracked.map((id) => (
        <JobWatcher key={id} meetingId={id} />
      ))}
    </>
  );
}

/**
 * One meeting being followed to its end.
 *
 * <p>A component per job rather than a loop inside one, because each needs its
 * own query and its own socket subscription — and hooks cannot be called in a
 * loop over a list that changes length.
 */
function JobWatcher({ meetingId }: { meetingId: string }) {
  const dispatch = useAppDispatch();
  const [live, setLive] = React.useState<MeetingStatus | null>(null);

  /*
   * Two routes to the same answer. The socket is the responsive one and the
   * poll is what makes it finish: a browser or proxy that drops the WebSocket
   * leaves the socket silent, and trusting it alone would leave a meeting that
   * was ready ten minutes ago still marked as running in this tab.
   */
  const { data } = useGetMeetingQuery(meetingId, { pollingInterval: 5000 });

  React.useEffect(() => {
    const sub = subscribeMeetingStatus(meetingId, {
      onEvent: (e) => {
        if (e.meetingId !== meetingId) return;
        setLive(e.status as MeetingStatus);
      },
    });
    return () => sub.deactivate();
  }, [meetingId]);

  const status: MeetingStatus | null = live ?? (data?.status as MeetingStatus | undefined) ?? null;
  const done = status !== null && isTerminal(status);

  /*
   * Whether this tab ever saw the meeting running.
   *
   * <p>The toast announces a *transition*, and this is what makes it one. An id
   * can arrive here already finished — the meeting page tracks whatever it
   * opens, and `sessionStorage` hands back whatever the tab was watching before
   * a reload — and without this the first poll came back READY and announced a
   * meeting that had been ready for an hour. Opening a processed meeting
   * greeted you with "it is ready", which is a notification about nothing
   * having happened.
   *
   * <p>A ref rather than state: nothing renders from it, and a re-render in the
   * same tick as the status arriving would race the effect below.
   */
  const sawRunning = React.useRef(false);
  if (status !== null && !isTerminal(status)) sawRunning.current = true;

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
    // Untracked either way. A finished meeting is not something to keep
    // polling, whether or not there was anything worth saying about it.
    untrackProcessing(meetingId);
    if (!sawRunning.current) return;
    const title = data?.title?.trim();
    // No `description` on the failure, and no Open button on the success.
    // The server's `errorMessage` is written for a log -- it names providers
    // and status codes -- and a button that appears over whatever is being read
    // and vanishes on a timer is one nobody can rely on reaching. The meeting
    // is in the list either way, and the page it opens says what went wrong in
    // full.
    if (status === "FAILED") {
      toast.error(title ? `Couldn't process "${title}".` : "Couldn't process that recording.");
    } else {
      toast.success(title ? `"${title}" is ready.` : "Your meeting is ready.");
    }
  }, [done, status, meetingId, data?.title, dispatch]);

  return null;
}
