/**
 * What a meeting that is still being made can honestly say about itself.
 *
 * ## The rule
 *
 * A stage is only marked complete when Orion has actually reported that
 * result. Nothing here is derived from where a percentage happens to have got
 * to: the bar is an *estimate* that eases forward on a timer (see lib/progress),
 * and reading stage completion off it would tick "Transcript ✓" on a meeting
 * that was still being transcribed.
 *
 * Two real sources, and only two:
 *
 * 1. **The status the worker reported**, which arrives over the socket and the
 *    poll. `SUMMARIZING` is the worker saying transcription finished; the
 *    status did not move by itself.
 * 2. **The resource actually being there** — segments, a summary. Strongest
 *    evidence of all, and it overrides everything.
 *
 * ## The one number that is not an estimate
 *
 * `PROGRESS_TRANSCRIBED` is a *reported* value, not an eased one. The pipeline
 * emits it explicitly — `emit("TRANSCRIBING", PROGRESS_TRANSCRIBED, "Transcript
 * ready; preparing summary...")` — after transcription and speaker refinement
 * have both finished but before the status moves to SUMMARIZING. It is the only
 * thing that distinguishes the start of the transcribe stage from its end, and
 * it is the other half of a contract with ai-service/app/pipeline.py, exactly
 * like `statusProgress` in lib/format.
 *
 * The estimate is clamped to its stage band and can sit anywhere below the
 * ceiling, so `progress >= PROGRESS_TRANSCRIBED` is only trusted when the
 * *reported* progress said so. Callers pass `reported`, not the eased number.
 *
 * ## Why Transcript and Speakers finish together
 *
 * They are not two reported stages. The pipeline runs speaker refinement
 * *between* the opening `TRANSCRIBING` event and the `PROGRESS_TRANSCRIBED`
 * one, and emits nothing in between — so from outside there is no moment at
 * which transcription is known to be done and speaker matching is known not to
 * be. Both therefore complete at the same marker.
 *
 * Showing "✓ Transcript ● Speakers" would mean inventing a boundary the backend
 * does not report, which is the one thing this module exists to refuse. Speakers
 * is still listed, because it is real work that really happens and it is most of
 * the wait on a long meeting — it just cannot be ticked early.
 */

import type { MeetingStatus } from "@/lib/types";

/**
 * The progress the worker reports once the transcript and the speaker pass are
 * both done. Mirrors `PROGRESS_TRANSCRIBED` in ai-service/app/pipeline.py.
 */
export const PROGRESS_TRANSCRIBED = 55;

export type StageState = "done" | "active" | "pending";

export type StageKey = "uploaded" | "transcript" | "speakers" | "summary";

export interface ProcessingStage {
  key: StageKey;
  label: string;
  state: StageState;
}

/** Everything known about a meeting in flight, from real sources only. */
export interface ProcessingFacts {
  status: MeetingStatus;
  /**
   * The progress the worker *reported*, not the eased estimate on the bar.
   * Undefined when nothing has been reported yet, which is not the same as 0.
   */
  reported?: number;
  /** Real transcript segments have been fetched and are non-empty. */
  hasTranscript?: boolean;
  /** A real summary has been fetched. */
  hasSummary?: boolean;
}

const ORDER: MeetingStatus[] = [
  "CREATED",
  "UPLOADED",
  "QUEUED",
  "TRANSCRIBING",
  "SUMMARIZING",
  "EXTRACTING",
  "READY",
];

/** Whether the worker has reported a status at or past `mark`. */
function reachedStatus(status: MeetingStatus, mark: MeetingStatus): boolean {
  const at = ORDER.indexOf(status);
  const want = ORDER.indexOf(mark);
  // FAILED is not on the ladder. A failed meeting has no stage past the one it
  // died in, and pretending otherwise is how a stuck spinner gets a tick.
  return at >= 0 && want >= 0 && at >= want;
}

/**
 * Whether the transcript — and with it the speaker pass — is finished.
 *
 * Three ways to know, any one of which is enough, and all three are things
 * Orion said rather than things inferred from a clock.
 */
function transcriptDone(facts: ProcessingFacts): boolean {
  if (facts.hasTranscript) return true;
  if (reachedStatus(facts.status, "SUMMARIZING")) return true;
  return (
    facts.status === "TRANSCRIBING" &&
    facts.reported !== undefined &&
    facts.reported >= PROGRESS_TRANSCRIBED
  );
}

/**
 * Whether the brief is actually in Orion.
 *
 * <p>Stricter than the transcript rule above, and deliberately. `EXTRACTING` is
 * the worker saying *it* has written a summary and moved on to action items —
 * but that summary is still inside the worker. `CallbackService.applyResult`
 * persists the summary, the action items and READY in one transaction, so until
 * then Orion does not have it and there is nothing to read.
 *
 * <p>Ticking on EXTRACTING would also leave the strip fully ticked while the
 * meeting was still processing, which reads as finished. The transcript can tick
 * earlier because the pipeline emits an explicit marker for it; there is no
 * equivalent "summary is available" signal, so the honest answer is the brief
 * arriving.
 */
function summaryDone(facts: ProcessingFacts): boolean {
  return Boolean(facts.hasSummary) || facts.status === "READY";
}

/**
 * The four stages, each with the state it can be shown in.
 *
 * Exactly one stage is `active` while a meeting is processing: the first one
 * that is not done. A finished meeting has four done stages; a failed one keeps
 * whatever it had reached and marks nothing active, so nothing spins for ever.
 */
export function processingStages(facts: ProcessingFacts): ProcessingStage[] {
  const uploaded = reachedStatus(facts.status, "QUEUED") || facts.status === "FAILED";
  const transcript = transcriptDone(facts);
  const summary = summaryDone(facts);

  const done: Record<StageKey, boolean> = {
    uploaded,
    transcript,
    // Same marker as the transcript, deliberately. See the header.
    speakers: transcript,
    summary,
  };

  const labels: Array<[StageKey, string]> = [
    ["uploaded", "Uploaded"],
    ["transcript", "Transcript"],
    ["speakers", "Speakers"],
    ["summary", "Summary"],
  ];

  // A failed meeting has no stage in progress. Leaving one `active` is what
  // leaves a spinner running under an error message.
  const stalled = facts.status === "FAILED";
  let activeTaken = stalled || facts.status === "READY";

  return labels.map(([key, label]) => {
    if (done[key]) return { key, label, state: "done" as const };
    if (!activeTaken) {
      activeTaken = true;
      return { key, label, state: "active" as const };
    }
    return { key, label, state: "pending" as const };
  });
}

/**
 * One sentence for what is happening right now.
 *
 * Derived from the reported status and the one reported progress marker — not
 * from the eased bar. The worker sends prose of its own ("Generating transcript
 * from audio..."), and it is deliberately not used here: it is written for a log
 * and it changes when the pipeline is refactored, which would make it a copy
 * decision nobody reviewed.
 */
export function stageText(facts: ProcessingFacts): string {
  switch (facts.status) {
    case "CREATED":
    case "UPLOADED":
      return "Uploading recording…";
    case "QUEUED":
      return "Preparing to process…";
    case "TRANSCRIBING":
      return transcriptDone(facts) ? "Preparing transcript…" : "Transcribing audio…";
    case "SUMMARIZING":
      return "Generating summary…";
    case "EXTRACTING":
      return "Extracting action items…";
    case "READY":
      return "Finishing meeting…";
    case "FAILED":
      return "Processing failed.";
    default:
      return "Processing…";
  }
}

/**
 * What each area of the meeting page should show, given what actually exists.
 *
 * <p>The page used to answer this with `status === "READY"` and nothing else:
 * everything — the tabs, the transcript, the summary, the chat rail — was
 * withheld behind one boolean, so a meeting being made was a progress card with
 * a blank page behind it. This is the same question asked per area, against real
 * availability rather than against an enum.
 *
 * <p>It lives here, as a pure function, because it is the part that can quietly
 * regress: a `&&` in the wrong place turns "generating your summary" back into
 * "No summary available", which is the same words the page said before and the
 * reason this work exists.
 *
 * <p><b>Everything it returns is temporary.</b> A READY meeting gets no banner,
 * no placeholder and no skeleton — every field resolves to the plain
 * already-shipped component, so the finished page is exactly what it was.
 */
export interface RevealPlan {
  /** The inline banner under the meeting metadata. Never on a finished meeting. */
  banner: boolean;
  /** Whether to render the tabs, panels and chat rail at all. */
  content: boolean;
  transcript: "ready" | "preparing";
  /** `empty` is the finished-and-genuinely-nothing case: "No summary available". */
  summary: "ready" | "generating" | "waiting" | "empty";
  actionItems: "ready" | "extracting" | "waiting";
  /** Whether the meeting chat has anything to ground an answer in. */
  chat: "ready" | "locked";
}

export function revealPlan(facts: ProcessingFacts): RevealPlan {
  const failed = facts.status === "FAILED";
  const processing = facts.status !== "READY" && !failed;
  const hasTranscript = Boolean(facts.hasTranscript);
  const hasSummary = Boolean(facts.hasSummary);

  return {
    banner: processing,
    // A failed meeting gets its existing error card and nothing else. Rendering
    // panels around it is what leaves skeletons pulsing for ever under an error
    // — the single worst outcome available here.
    content: !failed,
    transcript: hasTranscript ? "ready" : processing ? "preparing" : "ready",
    summary: hasSummary
      ? "ready"
      : !processing
        ? "empty"
        : hasTranscript
          ? "generating"
          : "waiting",
    actionItems: !processing ? "ready" : hasTranscript ? "extracting" : "waiting",
    /*
     * Locked only while the meeting is still being made.
     *
     * Keyed off the transcript *and* the processing state, and the second half
     * was missing: a finished meeting with no segments — a short recording that
     * caught no speech, which is a real and ordinary outcome — came out
     * `locked`, so a completed meeting sat there saying "AI Chat will be
     * available once the transcript is ready" about a transcript that was never
     * going to arrive. A processing message on a processed meeting, which is
     * exactly what a temporary state must never become.
     *
     * A READY meeting always gets the real rail. What that rail does with an
     * empty transcript is its own long-standing behaviour, and not something
     * this plan should be overriding.
     */
    chat: processing && !hasTranscript ? "locked" : "ready",
  };
}
