"use client";

import { Loader2, Square } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { statusLabel } from "@/lib/format";
import type { MeetingStatus } from "@/lib/types";

/**
 * The wait, on the page the result will appear on.
 *
 * <p>Saving a recording lands on the meeting it just made, so this is what
 * somebody watches — and the docked bar stands down here rather than draw a
 * second percentage for the same wait. Two numbers for one job read as two
 * jobs.
 *
 * <p><b>Stop comes with that.</b> The bar carried the only way to call the
 * pipeline off, so a bar that yields without handing the control over would
 * leave a wait that cannot be ended on the one page somebody is sitting on.
 *
 * <p>It is offered only while this meeting is the one being saved. What "stop"
 * does is delete the meeting — the worker is mid-flight and cannot be recalled
 * — and that is not something to put beside a file somebody imported an hour
 * ago from a page that never mentioned it.
 */
export function ProcessingCard({
  status,
  progress,
  message,
  onStop,
  stopping,
}: {
  status: MeetingStatus;
  progress: number;
  message?: string;
  onStop?: () => void;
  stopping?: boolean;
}) {
  // Clamped and rounded rather than printed raw: the worker sends a stage
  // estimate, and "37.499999%" or a value that briefly overshoots would both
  // read as a bug in the one number somebody is watching.
  const percent = Math.round(Math.min(100, Math.max(0, progress)));

  return (
    <Card>
      <CardHeader className="flex flex-row items-end justify-between gap-4 space-y-0 pb-4">
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <Loader2 className="h-4 w-4 animate-spin text-primary" /> {statusLabel(status)}…
        </CardTitle>
        {/* The number, given the weight the wait actually has. A bar alone
            says "something is happening"; a percentage says how much longer,
            which is the question being asked. Tabular figures so it does not
            jitter sideways as it counts up. */}
        <span className="shrink-0 text-2xl font-semibold leading-none tracking-tight tabular-nums">
          {percent}
          <span className="ml-0.5 text-base font-normal text-muted-foreground">%</span>
        </span>
      </CardHeader>
      <CardContent className="space-y-3 pb-6">
        <Progress value={percent} className="h-2" />
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            {message || "Working on your meeting brief. This updates live."}
          </p>
          {/* Moved down here from beside the title. It is the secondary
              action on this card and it deletes the meeting, so it has no
              business competing with the heading for first read — but it stays
              on the card, because this page carries the only way to call the
              pipeline off. */}
          {onStop && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground hover:text-destructive"
              disabled={stopping}
              onClick={onStop}
            >
              {stopping ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Square className="h-3 w-3 fill-current" />
              )}
              Stop
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
