"use client";

import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProcessingStage } from "@/lib/processing-stages";

/**
 * Which parts of a meeting are made, which is being made, and which are waiting.
 *
 * <p>Four short labels rather than a second progress bar. The bar says how far;
 * this says how far through <em>what</em>, which is the question somebody
 * actually has eight minutes into a recording that has not appeared yet.
 *
 * <p><b>Never colour alone.</b> Each stage carries an icon and a word, so the
 * three states are distinguishable without seeing green: a tick, a spinner, an
 * empty ring. The list is a `<ol>` because it is ordered and the order is the
 * information; the state of each is put into the accessible name rather than
 * left to the icon, so a screen reader hears "Transcript, done" and not
 * "Transcript" four times.
 */
export function ProcessingStages({
  stages,
  className,
}: {
  stages: ProcessingStage[];
  className?: string;
}) {
  return (
    <ol className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5", className)}>
      {stages.map((stage) => (
        <li
          key={stage.key}
          className={cn(
            "flex items-center gap-1.5 text-xs",
            stage.state === "done" && "text-muted-foreground",
            stage.state === "active" && "font-medium text-foreground",
            stage.state === "pending" && "text-muted-foreground/60",
          )}
        >
          <StageIcon state={stage.state} />
          <span>{stage.label}</span>
          {/* The state in words, for anything that cannot see the icon. Visually
              hidden rather than absent: "Transcript" on its own does not say
              whether it happened. */}
          <span className="sr-only">
            {stage.state === "done"
              ? ", done"
              : stage.state === "active"
                ? ", in progress"
                : ", waiting"}
          </span>
        </li>
      ))}
    </ol>
  );
}

function StageIcon({ state }: { state: ProcessingStage["state"] }) {
  if (state === "done") {
    // `text-success` is the token the rest of the app uses for a good outcome
    // — the same one StatusBadge's success variant is built on.
    return <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />;
  }
  if (state === "active") {
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" aria-hidden />;
  }
  // An outline, not a filled dot: a filled circle beside a tick reads as a
  // second kind of done.
  return (
    <span
      aria-hidden
      className="h-2.5 w-2.5 shrink-0 rounded-full border border-current opacity-60"
    />
  );
}
