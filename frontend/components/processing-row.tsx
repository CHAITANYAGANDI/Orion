"use client";

import * as React from "react";
import { subscribeMeetingStatus } from "@/lib/ws";
import { statusProgress, isTerminal } from "@/lib/format";
import { useMeetingProgress } from "@/lib/progress";
import { stageText, STATUS_ORDER } from "@/lib/processing-stages";
import { useGetMeetingQuery } from "@/lib/api";
import { Progress } from "@/components/ui/progress";
import type { MeetingStatus } from "@/lib/types";

/**
 * How often to ask the server where a job has got to.
 *
 * <p>Five seconds is chosen against the shortest thing worth seeing rather than
 * against server load: a stage on a brief recording can last ten. Polling
 * slower than that would let a whole stage begin and end between two requests,
 * which is the failure being fixed, arriving by a slower route.
 */
const POLL_MS = 5_000;

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
 * <p><b>The status comes from the socket and a poll, together.</b> Either alone
 * is wrong, and the socket alone was the bug:
 *
 * <p>A stage event is a <em>push with no replay</em>. Saving a recording
 * navigates here and the row mounts, and only then does SockJS handshake and
 * STOMP subscribe — several hundred milliseconds during which the worker is
 * already running and every event it emits is delivered to nobody. On a short
 * recording the whole pipeline can be over before the subscription exists. The
 * row then sat on the status the list was loaded with, `QUEUED`, whose band
 * ceiling is 4% — which is exactly the reported symptom: <b>a bar stuck at 4%
 * on a meeting that finished normally.</b> Catching the same events a moment
 * earlier gave 3% -> 35%, the same job, the same code, a different race.
 *
 * <p>So there is a poll underneath, which `lib/ws` has always said callers
 * need: <em>"should implement a polling fallback (GET /meetings/&#123;id&#125;)"</em>.
 * It is the floor, not the primary — the socket is still what makes a row move
 * within a second — and it covers every case a push cannot: an event emitted
 * before the subscription existed, a dropped connection, a proxy that silently
 * eats the upgrade, a tab restored from bfcache.
 *
 * <p>Only while the meeting is unfinished, and only for rows that are actually
 * processing, so a list of a hundred finished meetings opens no socket and
 * makes no request.
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

  // The floor. Stops the moment the *polled* status settles rather than when
  // the socket says so, because believing a push about the end of a job is the
  // same mistake as believing one about the middle of it.
  const polled = useGetMeetingQuery(meetingId, {
    skip: done,
    pollingInterval: POLL_MS,
  });
  const fromServer = polled.data?.status;

  // Whichever is further along wins, rather than whichever spoke last. A poll
  // in flight when a stage event lands returns the older status a moment later,
  // and "latest wins" would walk the row backwards -- the exact thing
  // lib/progress refuses to let the *bar* do, one layer up from where the bar
  // can see it.
  const status = furthest(live?.status, fromServer, fallback);

  // Only the socket carries a percentage; a polled status has just its floor,
  // which `useMeetingProgress` derives itself. Handing back a number that
  // belongs to a status we are no longer showing would clamp the bar into the
  // wrong band.
  const reported = status === live?.status ? live.progress : undefined;

  return { status, reported };
}

/** The most advanced of the statuses given, ignoring any that are unknown. */
function furthest(...statuses: (MeetingStatus | undefined)[]): MeetingStatus {
  let best: MeetingStatus = "CREATED";
  let rank = -1;
  for (const status of statuses) {
    if (!status) continue;
    // A terminal status outranks everything: it is the end of the job, and
    // FAILED does not sit on the ORDER list at all.
    if (isTerminal(status)) return status;
    const at = STATUS_ORDER.indexOf(status);
    if (at > rank) {
      rank = at;
      best = status;
    }
  }
  return best;
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
