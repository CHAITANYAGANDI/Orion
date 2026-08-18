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
import {
  Mic,
  Loader2,
  AlertTriangle,
  CalendarDays,
  User,
  FileText,
} from "lucide-react";
import { useRecordingStartedMutation, useGetPreferencesQuery } from "@/lib/api";
import { useRecording, useRecordingSession } from "@/lib/recording-context";
import { Button } from "@/components/ui/button";
import { defaultRecordingTitle } from "@/components/recording-bar";
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
      <NoteHeading startedAt={recorder.startedAt} started={started} />

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
 * What this is going to be called, when it happened, and whose it is.
 *
 * The title is the one Recallix will actually save under, shown rather than
 * asked for. A recording has no name until somebody has heard it, and a text
 * field here would be a question asked at the only moment nobody can answer it
 * — the meeting has not happened yet.
 */
function NoteHeading({ startedAt, started }: { startedAt: Date | null; started: boolean }) {
  const prefs = useGetPreferencesQuery();
  const { title, setTitle } = useRecordingSession();
  const owner = prefs.data?.displayName?.trim();

  // Fixed at the point the recording began, so the heading does not tick over
  // while the meeting runs. Before that there is nothing to date.
  const when = startedAt;

  return (
    <div className="space-y-2 border-b pb-4">
      {/*
       * Optional, and empty rather than pre-filled.
       *
       * The old heading printed the name the recording would be saved under,
       * which was honest and useless: the one thing worth writing down at the
       * start of a meeting is what the meeting is, and that was the one thing
       * there was nowhere to put. Left blank it falls back to the date, so
       * nobody is made to name a call before it has happened — but somebody who
       * knows it is the Tuesday design review can say so while it is still
       * true, instead of hunting for the meeting afterwards to rename it.
       */}
      <label className="sr-only" htmlFor="recording-title">
        Name this recording
      </label>
      <input
        id="recording-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={started ? defaultRecordingTitle(when ?? new Date()) : "New recording"}
        className={cn(
          "w-full rounded-lg border-2 border-transparent bg-transparent px-3 py-2",
          "text-2xl font-semibold tracking-tight outline-none transition-colors",
          "placeholder:font-normal placeholder:text-muted-foreground",
          "hover:border-input focus:border-primary focus:bg-background",
        )}
      />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <CalendarDays className="h-4 w-4" />
          {when ? when.toLocaleString() : "Not started"}
        </span>
        {/* Only shown once it is known. "Owner: —" is worse than no line: it
            reads as a missing value rather than a name nobody has set. */}
        {owner && (
          <span className="flex items-center gap-1.5">
            <User className="h-4 w-4" />
            Owner: {owner}
          </span>
        )}
      </div>
    </div>
  );
}

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
 * What is left before a recording: a button.
 *
 * Reached by opening /record directly — the Record button in the header starts
 * on its way here, so most people never see this. It stays because a bare page
 * offering no way to begin would be a dead end for anyone who bookmarked the
 * route.
 */
function Idle({ supported, onStart }: { supported: boolean; onStart: () => void }) {
  return (
    <div className="space-y-4">
      {/* Two facts, not a form. Neither asks for anything, and between them
          they cover what somebody would otherwise find out too late: what a
          microphone can hear, and who else hears it. */}
      <p className="text-sm text-muted-foreground">
        Records this device&apos;s microphone — everything it can pick up in the
        room. Anyone joining through headphones or an earpiece won&apos;t be on
        the recording.
      </p>
      <p className="text-sm text-muted-foreground">
        Your browser transcribes as you speak so you can follow along. That
        preview comes from the browser&apos;s own speech service — in Chrome the
        audio goes to Google — and is not saved. Your transcript is written
        afterwards by the provider named on the{" "}
        <Link
          href="/settings/security"
          className="underline underline-offset-2 hover:text-foreground"
        >
          Security tab
        </Link>
        .
      </p>

      <Button size="lg" className="w-full gap-2" disabled={!supported} onClick={onStart}>
        <Mic className="h-4 w-4" /> Start recording
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        Already have a file?{" "}
        <Link href="/upload" className="underline underline-offset-2 hover:text-primary">
          Upload a recording instead
        </Link>
      </p>
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
          : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}
