"use client";

/**
 * What Recallix is doing with a recording, drawn as the four things it does.
 *
 * <p>A bare percentage answers "how far" and nothing else, which is the wrong
 * question during a wait of several minutes. What somebody actually wants to
 * know is what is happening and what is left — so the stages are named, the one
 * running says what it means, and the ones after it are visibly still to come.
 *
 * <p>The same component draws the wait and the explanation. Before a recording
 * there is nothing to report, so every step sits in its "to come" state and the
 * panel reads as what will happen rather than as an empty progress bar. That is
 * the only honest thing a progress display can say about work not yet started,
 * and it is more use than the paragraph of prose it replaced.
 */

import * as React from "react";
import { Check, Loader2, AlertTriangle, X } from "lucide-react";
import { PIPELINE_STEPS, currentStep, type SavePhase, type StepKey } from "@/lib/use-save-job";
import type { MeetingStatus } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

type StepState = "done" | "active" | "todo" | "failed";

/** Where each step stands, given the phase and what the worker last said. */
export function stepStates(
  phase: SavePhase,
  status?: MeetingStatus,
): Record<StepKey, StepState> {
  const order = PIPELINE_STEPS.map((s) => s.key);
  const active = currentStep(phase, status);
  const activeIndex = active ? order.indexOf(active) : -1;

  const states = {} as Record<StepKey, StepState>;
  for (const [i, key] of order.entries()) {
    if (phase === "done") states[key] = "done";
    else if (phase === "failed") states[key] = i === activeIndex ? "failed" : i < activeIndex ? "done" : "todo";
    else if (activeIndex === -1) states[key] = "todo";
    else if (i < activeIndex) states[key] = "done";
    else if (i === activeIndex) states[key] = "active";
    else states[key] = "todo";
  }
  return states;
}

export function ProcessingSteps({
  phase,
  status,
  message,
  progress,
  label,
  onStop,
  onOpen,
  onDismiss,
  stopping,
}: {
  phase: SavePhase;
  status?: MeetingStatus;
  message?: string;
  /** 0-100 across the upload and the pipeline together. */
  progress: number;
  label: string;
  onStop?: () => void;
  onOpen?: () => void;
  onDismiss?: () => void;
  stopping?: boolean;
}) {
  const states = stepStates(phase, status);
  const running = phase !== "idle" && phase !== "done" && phase !== "failed";

  return (
    <div className="rounded-xl border bg-card/40 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold">
          {phase === "idle"
            ? "What happens after you stop"
            : phase === "done"
              ? "Done"
              : phase === "failed"
                ? "Processing failed"
                : "Processing"}
        </h2>
        {running && (
          <span className="font-mono text-sm tabular-nums text-muted-foreground">
            {progress}%
          </span>
        )}
      </div>

      {/* Only while something is running. A full bar under "What happens after
          you stop" would be claiming a finished job; an empty one would be
          claiming a stalled one. */}
      {running && (
        <div className="mt-3 space-y-1.5">
          <Progress value={progress} />
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      )}

      <ol className="mt-5 space-y-3">
        {PIPELINE_STEPS.map((step) => (
          <Step
            key={step.key}
            label={step.label}
            hint={
              // The worker's own words for the step it is on, which are more
              // specific than anything written here in advance.
              states[step.key] === "active" && message ? message : step.hint
            }
            state={states[step.key]}
          />
        ))}
      </ol>

      {phase === "failed" && message && (
        <p className="mt-4 text-sm text-destructive">{message}</p>
      )}

      {(onStop || onOpen || onDismiss) && (
        <div className="mt-5 flex flex-wrap gap-2">
          {running && onStop && (
            <Button variant="outline" size="sm" className="gap-2" disabled={stopping} onClick={onStop}>
              {stopping ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
              Stop processing
            </Button>
          )}
          {(phase === "done" || phase === "failed") && onOpen && (
            <Button size="sm" onClick={onOpen}>
              Open meeting
            </Button>
          )}
          {(phase === "done" || phase === "failed") && onDismiss && (
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              Dismiss
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Step({ label, hint, state }: { label: string; hint: string; state: StepState }) {
  return (
    <li className="flex items-start gap-3">
      <span
        className={cn(
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px]",
          state === "done" && "border-primary/40 bg-primary/10 text-primary",
          state === "active" && "border-primary bg-primary/10 text-primary",
          state === "failed" && "border-destructive/50 bg-destructive/10 text-destructive",
          state === "todo" && "border-border text-muted-foreground",
        )}
        aria-hidden
      >
        {state === "done" && <Check className="h-3 w-3" />}
        {state === "active" && <Loader2 className="h-3 w-3 animate-spin" />}
        {state === "failed" && <AlertTriangle className="h-3 w-3" />}
      </span>
      <span className="min-w-0">
        <span
          className={cn(
            "block text-sm",
            state === "todo" ? "text-muted-foreground" : "font-medium",
            state === "failed" && "text-destructive",
          )}
        >
          {label}
        </span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      {/* Said in words as well as in colour: the icons carry the state, and a
          screen reader gets nothing from a border. */}
      <span className="sr-only">
        {state === "done" ? "done" : state === "active" ? "in progress" : state === "failed" ? "failed" : "not started"}
      </span>
    </li>
  );
}
