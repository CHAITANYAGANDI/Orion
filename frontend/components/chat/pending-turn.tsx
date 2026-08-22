"use client";

/**
 * The question that has been asked and not yet answered.
 *
 * Renders exactly what the persisted exchange will render a few seconds later —
 * the prompt bubble, right-aligned — with the state of the answer underneath.
 * Nothing about the question moves when the real message arrives; the pending
 * copy is swapped for the persisted one in the same render. See
 * `lib/pending-turn`.
 *
 * ## Why the word is "Thinking"
 *
 * It said "Searching the transcript…", which is an implementation detail and,
 * increasingly, a false one. Between the click and the answer the service
 * classifies the question, may narrow to a named meeting, retrieves, filters
 * candidates on relevance, reads the action-item ledger and the decision
 * record, and then writes — and for a question the ledger answers, no
 * transcript is searched at all.
 *
 * A single honest word is better than a plausible wrong one, and better than a
 * sequence of invented ones. Cycling "Reading… Analysing… Reasoning…" would
 * describe stages that either do not exist or are not being reported, which is
 * a progress bar that knows nothing about the progress.
 *
 * ## Failure keeps the question
 *
 * A request that fails used to leave a toast and an empty rail: the question
 * had been cleared from the composer to make way for a bubble that never came,
 * so recovering it meant typing it again. It stays on screen with the failure
 * under it and a Retry beside that.
 */

import * as React from "react";
import { Loader2 } from "lucide-react";
import { PROMPT_BUBBLE } from "@/components/chat-message";
import type { PendingTurn as Turn } from "@/lib/pending-turn";

export function PendingTurn({ turn, onRetry }: { turn: Turn; onRetry?: () => void }) {
  return (
    <>
      <div className="flex justify-end">
        <div className={`max-w-[85%] ${PROMPT_BUBBLE}`}>
          <p className="whitespace-pre-wrap">{turn.question}</p>
        </div>
      </div>

      {turn.status === "asking" ? (
        <p
          className="flex items-center gap-2 text-sm italic text-muted-foreground"
          // Announced once when it appears, rather than on every re-render of
          // the thread around it.
          role="status"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Thinking…
        </p>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <span>Couldn&apos;t get an answer.</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
            >
              Retry
            </button>
          )}
        </p>
      )}
    </>
  );
}
