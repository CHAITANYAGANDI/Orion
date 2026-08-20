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
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Loader2 className="h-4 w-4 animate-spin text-primary" /> {statusLabel(status)}…
        </CardTitle>
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
      </CardHeader>
      <CardContent className="space-y-3">
        <Progress value={progress} />
        <p className="text-sm text-muted-foreground">
          {message || "Working on your meeting brief. This updates live."}
        </p>
      </CardContent>
    </Card>
  );
}
