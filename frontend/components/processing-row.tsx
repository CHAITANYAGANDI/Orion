"use client";

import * as React from "react";
import { subscribeMeetingStatus } from "@/lib/ws";
import { statusProgress, isTerminal } from "@/lib/format";
import { useMeetingProgress } from "@/lib/progress";
import { stageText } from "@/lib/processing-stages";
import { Progress } from "@/components/ui/progress";
import type { MeetingStatus } from "@/lib/types";

/**
 * A meeting still being made, said inside its own row in the list.
 *
 * <p>Home is where somebody lands after pressing Save, and the meeting is
 * already in the list — it just said "Processing" and nothing else, so there was
 * no way to tell a job thirty seconds in from one nearly done. This adds the
 * stage and the bar to the row that is already there, rather than a separate
 * section or a second card: the meeting has one place in the list, and it keeps
 * it while it is being made.
 *
 * <p><b>The status is live, from the socket.</b> Home does not poll its list, so
 * without this the row would freeze on whatever status the page load happened to
 * see. This is the same subscription the meeting page and the docked bar use;
 * only rows that are actually processing open one, so a list of finished
 * meetings costs nothing.
 */
export function useLiveMeetingStatus(meetingId: string, fallback: MeetingStatus) {
  const [live, setLive] = React.useState<{ status: MeetingStatus; progress: number } | null>(null);

  const done = isTerminal(fallback);
  React.useEffect(() => {
    // A finished meeting has nothing left to report. Subscribing anyway would
    // hold a socket per row on a list of a hundred meetings.
    if (done) return;
    const sub = subscribeMeetingStatus(meetingId, {
      onEvent: (e) => {
        if (e.meetingId !== meetingId) return;
        setLive({ status: e.status as MeetingStatus, progress: e.progress });
      },
    });
    return () => sub.deactivate();
  }, [meetingId, done]);

  // The live status wins over the cached one, which is what lets a row stop
  // saying "Processing" the moment the socket says otherwise -- without this
  // hook needing to refetch anything.
  //
  // It deliberately does not invalidate the meetings cache when a meeting
  // settles. That would make every row in a list depend on the Redux store, and
  // the docked bar already does it for every job this tab started or opened
  // (see components/processing-dock). What is left over -- a meeting processing
  // in a different tab, finishing while this list is open -- still renders
  // correctly here, because the status on screen is this one.
  const status = live?.status ?? fallback;

  return { status, reported: live?.progress };
}

/**
 * The stage, the bar and the percentage, sized for a list row.
 *
 * <p>Deliberately not the meeting page's banner. That one carries the four
 * stages and a Stop control and belongs under a page heading; this is three
 * lines inside a row that also has to stay readable next to nine finished
 * meetings.
 */
export function ProcessingRow({
  meetingId,
  status,
  reported,
}: {
  meetingId: string;
  status: MeetingStatus;
  reported?: number;
}) {
  const percent = Math.round(
    useMeetingProgress(meetingId, status, reported ?? statusProgress(status)),
  );

  return (
    <span className="mt-2 block space-y-1.5">
      <span className="block text-xs text-muted-foreground">{stageText({ status, reported })}</span>
      <span className="flex items-center gap-2">
        <Progress
          value={percent}
          className="h-1 min-w-0 flex-1"
          aria-label="Processing progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        />
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{percent}%</span>
      </span>
    </span>
  );
}
