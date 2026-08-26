"use client";

import { Loader2, Square } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { statusLabel } from "@/lib/format";
import type { MeetingStatus } from "@/lib/types";

/**
 * The wait, on the page the result will appear on.
 *
 * <p><b>A banner, where this used to be the page.</b> It was a full-width Card
 * with a two-line header and a 2xl percentage, and because everything else on a
 * meeting's page is gated on READY it was the *only* thing rendered — so saving
 * a forty-minute recording turned the app into a progress screen for eight
 * minutes. That was never what was happening underneath: the ai-service
 * consumes from Kafka and has never once checked whether a browser is open.
 * A page that fills itself with a percentage is telling the user their
 * attention is load-bearing, and it is not.
 *
 * <p>So it is one row now: what stage, how far, and a way to call it off. The
 * job itself is followed by the docked bar in the shell, which is what makes
 * leaving this page free — see components/processing-dock.tsx. This stays
 * because arriving at a meeting that is still being made should say so on the
 * meeting, rather than showing an empty document and a bar in the corner.
 *
 * <p><b>Stop comes with it.</b> This page carries the only way to call the
 * pipeline off, and what "stop" does is delete the meeting — the worker is
 * mid-flight and cannot be recalled. That is not something to put beside a file
 * somebody imported an hour ago from a page that never mentioned it, so it is
 * offered only while this meeting is the one being saved.
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
    <div className="no-print rounded-lg border bg-muted/30 px-4 py-3">
      <div className="flex items-center gap-3">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
        <span className="shrink-0 text-sm font-medium">{statusLabel(status)}…</span>
        {/* Takes the middle, so the row reads left to right as one sentence:
            what is happening, how far along, how much is left. */}
        <Progress value={percent} className="h-1.5 min-w-0 flex-1" />
        <span className="shrink-0 text-sm font-medium tabular-nums">{percent}%</span>
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
      {/* The reassurance is the substance, not the decoration: the complaint
          this whole change answers was somebody believing they had to sit on
          the page for the transcription to continue. */}
      <p className="mt-1.5 pl-7 text-xs text-muted-foreground">
        {message || "This carries on in the background — you can close this page."}
      </p>
    </div>
  );
}
