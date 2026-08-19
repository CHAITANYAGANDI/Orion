"use client";

/**
 * Record a live meeting from the browser.
 *
 * One source: the microphone. There was a second mode that also captured the
 * audio of another tab, for meetings happening inside the browser, and it is
 * gone — see lib/use-recorder.ts for why. What is left needs no choosing, which
 * is most of the reason the page in front of it got shorter.
 *
 * The result goes down the same presigned-upload → create-meeting path the
 * import dialog uses, so processing is identical from there on.
 *
 * Nothing is asked before the microphone opens. There were two questions —
 * which of two capture modes, and whether the room had been told — and both
 * have been removed: the first had one answer left, the second on request. What
 * remains before a recording is a single button, and Record in the header skips
 * even that by starting on the way here.
 *
 * The consent tick going means Recallix no longer has anything to say about
 * consent for a recording, and says nothing rather than something convenient.
 * See where the meeting is created in components/recording-bar.tsx.
 *
 * The recorder itself lives in the shell too, so navigating away mid-meeting no
 * longer destroys the recording. This page is a view onto it: mount, unmount,
 * come back, and a running recording is still running.
 */

import * as React from "react";
import Link from "next/link";
import { Mic, Loader2, AlertTriangle, User, FileText } from "lucide-react";
import { useRecordingStartedMutation } from "@/lib/api";
import { useRecording, useRecordingSession } from "@/lib/recording-context";
import { Button } from "@/components/ui/button";
import { ProcessingSteps } from "@/components/processing-steps";
import { stopwatch } from "@/lib/format";
import { cn } from "@/lib/utils";

export default function RecordPage() {
  const recorder = useRecording();
  const [announceRecording] = useRecordingStartedMutation();

  const started = recorder.state !== "idle";

  /**
   * Begin, and tell the server we did.
   *
   * The microphone is the one thing the server cannot observe, and the point of
   * telling it is the other devices: a laptop recording and a phone in a pocket
   * are the same account. Fired and forgotten on purpose — a notification that
   * could not be written must never be the reason a recording did not start.
   */
  async function onStart() {
    await recorder.start();
    void announceRecording();
  }

  return (
    // Clearance for the docked control bar is added by the shell, which knows
    // whether one is showing; adding it again here would leave a gap under the
    // setup, where there is no bar.
    <div className="mx-auto max-w-3xl space-y-6">
      {!recorder.supported && (
        <Notice tone="error" icon={AlertTriangle}>
          This browser can&apos;t record audio.{" "}
          <Link href="/upload" className="underline underline-offset-2">
            Upload a file instead
          </Link>
          .
        </Notice>
      )}

      {recorder.error && (
        <Notice tone="error" icon={AlertTriangle}>
          {recorder.error}
        </Notice>
      )}

      {/* No pipeline branch. Saving leaves for Home and the wait happens in the
          docked bar there, so by the time there is anything to watch this page
          is behind you. */}
      {started ? (
        <InProgress state={recorder.state} />
      ) : (
        <Idle supported={recorder.supported} onStart={() => void onStart()} />
      )}
    </div>
  );
}

/* --------------------------------- pieces -------------------------------- */

/**
 * The body of a meeting that is being recorded.
 *
 * It says the transcript is not coming yet, because it is not. Recallix
 * transcribes after Stop — the audio is captured in the browser, uploaded, and
 * sent through the pipeline as one file. An empty pane that looked like it was
 * waiting for words would be a promise of live captions the product does not
 * make, and the person watching it would conclude their microphone was broken.
 */
function InProgress({ state }: { state: string }) {
  const { transcript } = useRecordingSession();
  const hasWords = transcript.phrases.length > 0 || transcript.interim !== "";

  // Kept, and only this one, because the browser's permission prompt is modal
  // and a page with nothing on it behind that prompt gives no clue what is
  // being asked for or why.
  if (state === "requesting") {
    return (
      <Empty>
        <Loader2 className="mx-auto h-7 w-7 animate-spin text-muted-foreground" />
        <p className="mt-3 font-medium">Waiting for permission…</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Allow the microphone to start recording.
        </p>
      </Empty>
    );
  }

  if (state === "stopped") {
    return (
      <div className="space-y-4">
        {/* The words stay up after Stop. They are the only reminder of what was
            just said, and they are about to be thrown away — clearing the pane
            at the moment somebody is deciding whether to save or discard takes
            away the thing that decision is about. */}
        {hasWords && <Phrases />}
        <Empty>
          <FileText className="mx-auto h-7 w-7 text-muted-foreground" />
          <p className="mt-3 font-medium">Recording finished</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Save it below to transcribe it. Nothing has left this browser yet, so
            closing the tab now would lose the audio.
          </p>
        </Empty>
      </div>
    );
  }

  /*
   * Recording, and nothing to say about it.
   *
   * There was a panel here announcing "Recording" over a pulsing microphone,
   * and under it either an explanation that the transcript comes later or an
   * invitation to switch live text on. It is gone. Every word of it was already
   * on screen — the timer is running in the bar, the waveform is moving, the
   * Stop button is red, and the live text toggle is right there — so the panel
   * restated what the controls were already saying, in the space the words are
   * about to occupy. Empty until there is something to put here is the point:
   * this is a page for a meeting, and the meeting has not said anything yet.
   */
  return (
    <div className="space-y-4">
      {hasWords && <Phrases />}

      {state === "paused" && hasWords && (
        <p className="text-center text-sm text-muted-foreground">
          Paused — nothing is being recorded or transcribed.
        </p>
      )}

      {/* A line, not a panel: live text failing says nothing about the
          recording, and dressing it up as a status board implies otherwise. */}
      {transcript.error && (
        <p className="text-center text-xs text-muted-foreground">{transcript.error}</p>
      )}
    </div>
  );
}

/**
 * The live text.
 *
 * Grouped into phrases with a timestamp apiece, which is what the finished
 * transcript looks like — so this reads as an early draft of a thing the user
 * will see again rather than as a different feature. The in-progress phrase is
 * dimmed because it is going to change, sometimes completely, and presenting a
 * guess in the same weight as a settled line is how somebody comes to believe
 * the transcript got a name wrong when it has not been written yet.
 */
function Phrases() {
  const { transcript } = useRecordingSession();
  const endRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [transcript.phrases.length, transcript.interim]);

  return (
    <div className="space-y-5">
      {transcript.phrases.map((phrase) => (
        <div key={phrase.id} className="flex gap-3">
          {/* One generic speaker. Who said what is decided by diarisation, on
              the server, after the upload — inventing speaker labels here would
              mean contradicting the real transcript later. */}
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted">
            <User className="h-3.5 w-3.5 text-muted-foreground" />
          </span>
          <div className="min-w-0 flex-1">
            <span className="text-xs text-muted-foreground">{stopwatch(phrase.at)}</span>
            <p className="mt-0.5 text-[15px] leading-relaxed">{phrase.text}</p>
          </div>
        </div>
      ))}

      {transcript.interim && (
        <div className="flex gap-3">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted">
            <User className="h-3.5 w-3.5 text-muted-foreground" />
          </span>
          <p className="mt-5 min-w-0 flex-1 text-[15px] leading-relaxed text-muted-foreground">
            {transcript.interim}
          </p>
        </div>
      )}

      <p className="border-t pt-3 text-xs text-muted-foreground">
        A rough preview from your browser&apos;s speech service, not saved.
        Recallix writes the real transcript — punctuated, with speakers
        separated — after you stop.
      </p>

      {/*
       * The scroll target, and the reason it carries a margin.
       *
       * `scrollIntoView` aligns to the viewport, which has no idea its bottom
       * edge is under a fixed control bar — so the newest line, the one this
       * exists to reveal, was scrolled to exactly where the bar covers it.
       * `scroll-margin-bottom` is the one property that says otherwise, and it
       * spends the same measured bar height the page padding does.
       */}
      <div
        ref={endRef}
        style={{ scrollMarginBottom: "calc(var(--recording-bar, 0px) + 3rem)" }}
      />
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-dashed p-8 text-center">{children}</div>;
}

/**
 * Before anything has been recorded.
 *
 * <p>What was here: a name field, a "Not started" line, two paragraphs of
 * explanation and a footnote link to the upload page. All of it removed on
 * request, and the replacement is not more prose — it is the same panel that
 * draws the wait afterwards, showing the four stages a recording goes through
 * before it is readable.
 *
 * <p>That is the useful version of an empty state: it answers "what is this
 * going to do to my meeting", which is the question somebody standing in front
 * of a Record button actually has, and it means the page looks like itself
 * rather than rearranging the moment work starts.
 *
 * <p>The button stays, alone. Reached directly, a page offering no way to begin
 * is a dead end for anyone who bookmarked the route — the Record control in the
 * header starts on its way here, so most people never see this at all.
 */
function Idle({ supported, onStart }: { supported: boolean; onStart: () => void }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-10 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Mic className="h-5 w-5" />
        </span>
        <div>
          <p className="text-lg font-semibold">Ready to record</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Recallix captures this device&apos;s microphone and writes the notes
            once you stop.
          </p>
        </div>
        <Button size="lg" className="gap-2" disabled={!supported} onClick={onStart}>
          <Mic className="h-4 w-4" /> Start recording
        </Button>
      </div>

      <ProcessingSteps phase="idle" progress={0} label="" />
    </div>
  );
}

function Notice({
  tone,
  icon: Icon,
  children,
}: {
  tone: "warn" | "error";
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border p-3 text-sm",
        tone === "error"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-amber-500/40 bg-amber-500/10 text-amber-400",
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}
