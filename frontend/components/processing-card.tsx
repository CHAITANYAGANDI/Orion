"use client";

import { Square, Loader2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { ProcessingStages } from "@/components/processing-stages";
import { processingStages, stageText, type ProcessingFacts } from "@/lib/processing-stages";
import type { MeetingStatus } from "@/lib/types";

/**
 * The wait, on the meeting's own page — one banner, under the metadata.
 *
 * <p><b>It used to be the page.</b> This was a full-width Card with a two-line
 * header and a 2xl percentage, and because the tabs, the transcript, the summary
 * and the chat rail were all gated on `status === "READY"`, it was the *only*
 * thing rendered. A forty-minute recording therefore turned the app into a
 * progress screen for eight minutes, with nothing to read and nothing to do.
 *
 * <p>Now it is a slim band that sits beneath the title, duration and tags, and
 * the rest of the meeting renders around it in its normal layout with per-area
 * placeholders. Nothing about the finished page changed: when the meeting is
 * READY this does not render at all, and what is left is exactly what was there
 * before.
 *
 * <p><b>It is the only progress indicator on this route.</b> Nothing else in
 * the shell draws one — see components/processing-dock, which watches jobs and
 * renders nothing — so one job never draws two bars in one view.
 *
 * <p><b>Stop stays here.</b> This page carries the only control that ends a
 * pipeline, and what it does is delete the meeting — the worker is mid-flight
 * and cannot be recalled. It is offered only while this is the meeting being
 * saved, so it never appears beside a file imported an hour ago from a page
 * that never mentioned it.
 */
export function ProcessingCard({
  status,
  progress,
  reported,
  hasTranscript,
  hasSummary,
  message,
  onStop,
  stopping,
}: {
  status: MeetingStatus;
  /** The eased estimate, for the bar only. Never used to decide a stage. */
  progress: number;
  /** The progress the worker actually reported. See lib/processing-stages. */
  reported?: number;
  hasTranscript?: boolean;
  hasSummary?: boolean;
  message?: string;
  onStop?: () => void;
  stopping?: boolean;
}) {
  // Clamped and rounded rather than printed raw: the worker sends a stage
  // estimate, and "37.499999%" or a value that briefly overshoots would both
  // read as a bug in the one number somebody is watching.
  const percent = Math.round(Math.min(100, Math.max(0, progress)));
  const facts: ProcessingFacts = { status, reported, hasTranscript, hasSummary };
  const stages = processingStages(facts);

  return (
    <div className="no-print space-y-3 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="flex shrink-0 items-center gap-1.5 text-sm font-medium">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
          Processing
          <span className="text-muted-foreground">·</span>
          <span className="tabular-nums">{percent}%</span>
        </span>
        {/* Explicit rather than left to Radix, which reports `indeterminate`
            until a value is committed — so a bar that visually moved announced
            nothing at all. */}
        <Progress
          value={percent}
          className="h-1.5 min-w-0 flex-1"
          aria-label="Meeting processing progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        />
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

      {/* What is happening, in one line. The worker's own message is preferred
          when it sent one, because that is the most specific thing anybody
          knows; the derived sentence is the floor under it. */}
      <p className="text-sm text-muted-foreground">{message || stageText(facts)}</p>

      <ProcessingStages stages={stages} />

      {/* The sentence this whole change exists for. The complaint was somebody
          believing they had to sit on the page for transcription to continue —
          it never did, and nothing on screen said so. */}
      <p className="text-xs text-muted-foreground">
        You can leave this page. Processing continues automatically.
      </p>
    </div>
  );
}
