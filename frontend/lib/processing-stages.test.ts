import { describe, it, expect } from "vitest";
import {
  processingStages,
  stageText,
  revealPlan,
  PROGRESS_TRANSCRIBED,
  type ProcessingFacts,
  type StageKey,
} from "@/lib/processing-stages";

/**
 * What a meeting in flight is allowed to claim about itself.
 *
 * <p>The rule under every test here: a stage is ticked only when Reverie has
 * actually reported that result. The bar on screen is an estimate that eases
 * forward on a timer, and the failure this file exists to prevent is a stage
 * going green because a clock moved rather than because anything happened.
 */
function state(facts: ProcessingFacts): Record<StageKey, string> {
  return Object.fromEntries(
    processingStages(facts).map((s) => [s.key, s.state]),
  ) as Record<StageKey, string>;
}

describe("processing stages", () => {
  it("ticks nothing but Uploaded when the job has only been queued", () => {
    expect(state({ status: "QUEUED" })).toEqual({
      uploaded: "done",
      transcript: "active",
      speakers: "pending",
      summary: "pending",
    });
  });

  it("does not tick the transcript from an eased percentage", () => {
    // The whole point. 40% into the TRANSCRIBING band is the bar's guess, not a
    // report, and a tick here would be a lie told confidently.
    expect(state({ status: "TRANSCRIBING", reported: 40 }).transcript).toBe("active");
  });

  it("ticks the transcript on the marker the worker actually reports", () => {
    // PROGRESS_TRANSCRIBED is emitted explicitly, after transcription and the
    // speaker pass both finish. It is the one number here that is not a guess.
    const done = state({ status: "TRANSCRIBING", reported: PROGRESS_TRANSCRIBED });
    expect(done.transcript).toBe("done");
    expect(done.speakers).toBe("done");
    expect(done.summary).toBe("active");
  });

  it("ticks the transcript and speakers together, because that is what is reported", () => {
    // Speaker refinement runs *between* the opening TRANSCRIBING event and the
    // PROGRESS_TRANSCRIBED one, and nothing is emitted in between -- so there
    // is no moment at which transcription is known done and matching is known
    // not to be. Splitting them would invent a boundary the backend does not
    // report.
    // Compared on *doneness*, not on the literal state: only one stage may be
    // `active` at a time, so before the marker they read "active" and "pending"
    // while both being equally unfinished.
    const done = (v: string) => v === "done";
    for (const reported of [5, 30, 54, 55, 90]) {
      const s = state({ status: "TRANSCRIBING", reported });
      expect(done(s.transcript), `reported=${reported}`).toBe(done(s.speakers));
    }
  });

  it("treats a status past transcription as proof the transcript is done", () => {
    // The status did not move by itself: SUMMARIZING is the worker saying it
    // finished transcribing.
    expect(state({ status: "SUMMARIZING" }).transcript).toBe("done");
    expect(state({ status: "SUMMARIZING" }).summary).toBe("active");
  });

  it("does not tick the summary while it is only being extracted", () => {
    // EXTRACTING means the worker has a summary, not that Reverie does --
    // applyResult persists the brief and READY in one transaction. Ticking here
    // would show a fully-ticked strip on a meeting still being processed, and
    // would claim a result nobody can read yet.
    expect(state({ status: "EXTRACTING" }).summary).toBe("active");
  });

  it("lets the data itself override the status", () => {
    // Strongest evidence there is. If segments are on screen, the transcript
    // exists whatever any enum says.
    expect(state({ status: "TRANSCRIBING", reported: 5, hasTranscript: true }).transcript)
      .toBe("done");
    expect(state({ status: "SUMMARIZING", hasSummary: true }).summary).toBe("done");
  });

  it("marks every stage done for a finished meeting", () => {
    expect(state({ status: "READY" })).toEqual({
      uploaded: "done",
      transcript: "done",
      speakers: "done",
      summary: "done",
    });
  });

  it("leaves nothing active on a failed meeting", () => {
    // The bug this prevents: a skeleton or a spinner still going under an error
    // message, for as long as the tab stays open.
    const failed = processingStages({ status: "FAILED" });
    expect(failed.some((s) => s.state === "active")).toBe(false);
  });

  it("does not credit a failed meeting with work it never did", () => {
    expect(state({ status: "FAILED" }).summary).toBe("pending");
  });

  it("has exactly one stage in progress while processing", () => {
    for (const status of ["QUEUED", "TRANSCRIBING", "SUMMARIZING", "EXTRACTING"] as const) {
      const active = processingStages({ status }).filter((s) => s.state === "active");
      expect(active, status).toHaveLength(1);
    }
  });

  it("never puts a pending stage before a done one", () => {
    // The strip is read left to right as a sequence; a gap in it would say the
    // pipeline skipped a step.
    const order = processingStages({ status: "SUMMARIZING" }).map((s) => s.state);
    const lastDone = order.lastIndexOf("done");
    expect(order.slice(0, lastDone).every((s) => s === "done")).toBe(true);
  });
});

describe("stage text", () => {
  it("distinguishes transcribing from transcript-ready on the reported marker", () => {
    expect(stageText({ status: "TRANSCRIBING", reported: 5 })).toBe("Transcribing audio…");
    expect(stageText({ status: "TRANSCRIBING", reported: PROGRESS_TRANSCRIBED }))
      .toBe("Preparing transcript…");
  });

  it("names the stage for every status a meeting can be in", () => {
    const statuses = ["CREATED", "UPLOADED", "QUEUED", "TRANSCRIBING",
      "SUMMARIZING", "EXTRACTING", "READY", "FAILED"] as const;
    for (const status of statuses) {
      const text = stageText({ status });
      expect(text, status).toBeTruthy();
      // No status may fall through to a shrug.
      expect(text, status).not.toBe("Processing…");
    }
  });
});

/**
 * What each area of the meeting page shows, and — the part that matters — what
 * it stops showing the moment the meeting is finished.
 *
 * <p>The processing experience is additive and temporary. A READY meeting must
 * come out of this with no banner, no placeholder and no skeleton anywhere, so
 * that what renders is exactly the page that shipped before any of this.
 */
describe("the reveal plan", () => {
  it("gives a finished meeting nothing temporary at all", () => {
    // Requirement in one assertion: complete = the existing meeting page.
    expect(revealPlan({ status: "READY", hasTranscript: true, hasSummary: true })).toEqual({
      banner: false,
      content: true,
      transcript: "ready",
      summary: "ready",
      actionItems: "ready",
      chat: "ready",
    });
  });

  it("keeps the page's structure while the meeting is being made", () => {
    // Not a blank page behind a progress card, which is what `ready &&` gave.
    const plan = revealPlan({ status: "TRANSCRIBING" });
    expect(plan.content).toBe(true);
    expect(plan.banner).toBe(true);
  });

  it("says the summary is waiting before there is a transcript", () => {
    expect(revealPlan({ status: "TRANSCRIBING" }).summary).toBe("waiting");
  });

  it("says the summary is generating once the transcript exists", () => {
    expect(revealPlan({ status: "SUMMARIZING", hasTranscript: true }).summary)
      .toBe("generating");
  });

  it("never says a summary is merely absent while one is being written", () => {
    // "No summary available" describes a finished meeting that turned out to
    // have nothing in it. Said over a summary being generated it is a wrong
    // answer given confidently.
    for (const status of ["QUEUED", "TRANSCRIBING", "SUMMARIZING", "EXTRACTING"] as const) {
      expect(revealPlan({ status }).summary, status).not.toBe("empty");
      expect(revealPlan({ status, hasTranscript: true }).summary, status).not.toBe("empty");
    }
  });

  it("does say the summary is empty on a finished meeting that produced none", () => {
    // The existing message is still correct here, and still shown.
    expect(revealPlan({ status: "READY", hasTranscript: true }).summary).toBe("empty");
  });

  it("reveals the transcript as soon as it exists, without waiting for the summary", () => {
    const plan = revealPlan({ status: "SUMMARIZING", hasTranscript: true });
    expect(plan.transcript).toBe("ready");
    expect(plan.summary).toBe("generating");
  });

  it("shows a placeholder rather than an empty transcript before then", () => {
    // An empty transcript reads as a recording that captured nothing.
    expect(revealPlan({ status: "TRANSCRIBING" }).transcript).toBe("preparing");
  });

  it("unlocks the chat on the transcript existing, not on a status", () => {
    expect(revealPlan({ status: "SUMMARIZING" }).chat).toBe("locked");
    expect(revealPlan({ status: "SUMMARIZING", hasTranscript: true }).chat).toBe("ready");
  });

  it("never locks the chat on a finished meeting, even one with no transcript", () => {
    // The bug this pins, seen on a real 19-second recording that caught no
    // speech: READY, a summary, and zero segments. Keying the lock on the
    // transcript alone left a *processed* meeting saying "AI Chat will be
    // available once the transcript is ready" about one that was never coming.
    //
    // A temporary processing message must never outlive processing. What the
    // real rail does with an empty transcript is its own long-standing
    // behaviour and not this plan's business.
    expect(revealPlan({ status: "READY", hasSummary: true }).chat).toBe("ready");
    expect(revealPlan({ status: "READY", hasSummary: true, hasTranscript: false }).chat)
      .toBe("ready");
  });

  it("shows no processing state anywhere on a finished meeting that produced nothing", () => {
    // The whole screen for that recording, in one assertion.
    expect(revealPlan({ status: "READY", hasSummary: true })).toEqual({
      banner: false,
      content: true,
      transcript: "ready",
      summary: "ready",
      actionItems: "ready",
      chat: "ready",
    });
  });

  it("distinguishes waiting for action items from extracting them", () => {
    expect(revealPlan({ status: "TRANSCRIBING" }).actionItems).toBe("waiting");
    expect(revealPlan({ status: "EXTRACTING", hasTranscript: true }).actionItems)
      .toBe("extracting");
  });

  it("renders no panels at all for a failed meeting", () => {
    // The failure card is the whole screen. Panels around it would be skeletons
    // pulsing for ever under an error message, which is the worst outcome here.
    const plan = revealPlan({ status: "FAILED" });
    expect(plan.content).toBe(false);
    expect(plan.banner).toBe(false);
  });

  it("leaves a failed meeting with nothing claiming to be in progress", () => {
    const plan = revealPlan({ status: "FAILED" });
    expect(plan.summary).not.toBe("generating");
    expect(plan.actionItems).not.toBe("extracting");
    expect(plan.transcript).not.toBe("preparing");
  });
});
