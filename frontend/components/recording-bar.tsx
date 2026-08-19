"use client";

/**
 * The controls for a recording that is already running.
 *
 * Docked to the bottom of the window rather than placed on the record page,
 * because the recorder outlives the page: it lives in the app shell so that
 * looking something up mid-meeting does not stop the microphone. Controls that
 * only existed on /record meant the one action people actually need in a hurry
 * — Stop — was a navigation away, and a header pill was the only evidence
 * anything was happening.
 *
 * Everything here is about the current recording. Choosing a mode, reading the
 * announcement and ticking the consent box all happen before there is one, and
 * stay on the page where there is room to read them.
 */

import * as React from "react";
import { useRouter, usePathname } from "next/navigation";
import { toast } from "sonner";
import {
  Mic,
  ChevronDown,
  Pause,
  Play,
  Square,
  Loader2,
  UploadCloud,
  RotateCcw,
  X,
  Check,
  AlertTriangle,
} from "lucide-react";
import {
  useRecording,
  useRecordingSession,
  useRecordingJob,
} from "@/lib/recording-context";
import { stopwatch } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

/**
 * How long the input may be silent before saying so.
 *
 * Long enough to sit through a pause in the conversation, short enough that a
 * muted microphone is caught in the first exchange rather than at the end of
 * the meeting. Every second under this is a second of a recording somebody
 * believes is working.
 */
const SILENCE_GRACE_SECONDS = 8;

/** The title a recording is saved under until it is renamed. */
export function defaultRecordingTitle(now: Date = new Date()): string {
  return `Recording — ${now.toLocaleString()}`;
}

export function RecordingBar() {
  const recorder = useRecording();
  const session = useRecordingSession();
  const router = useRouter();
  const pathname = usePathname();

  /**
   * The upload and the pipeline, owned by the provider.
   *
   * <p>This component used to own them. It cannot any more: the record page
   * draws the same pipeline as a set of stages, and two components holding one
   * upload between them is two uploads the first time both render.
   */
  const job = useRecordingJob();
  const { phase, busy, working, stopping, overallProgress, label } = job;

  const live = recorder.state === "recording" || recorder.state === "paused";
  const unsaved = recorder.state === "stopped" && recorder.result !== null;
  /**
   * A recording that captured nothing.
   *
   * <p>Stopping within the first moment can leave no chunk with any bytes in
   * it. There is nothing to send, and offering Save anyway spends a presign and
   * a PUT to be refused by the server with a sentence about object sizes.
   */
  const empty = unsaved && recorder.result!.file.size === 0;

  /**
   * Stop the pipeline, which means deleting what it is working on.
   *
   * <p>The worker is mid-flight and cannot be recalled, so this deletes the
   * meeting instead. Its callbacks already handle one that is no longer there.
   * The compute is spent either way; what is stopped is the meeting existing.
   */
  async function handleStop() {
    if (
      !window.confirm(
        "Stop processing?\n\nThe meeting and its recording are deleted. The audio " +
          "only exists on the server now, so this cannot be undone.",
      )
    ) {
      return;
    }
    await job.stop();
  }

  /**
   * Throw the recording away, and leave the page that was about it.
   *
   * <p>Only from /record. That page has nothing left to show once the audio is
   * gone — it falls back to "Ready to record", which reads as an invitation to
   * do again the thing just abandoned. Everywhere else the bar is incidental to
   * whatever is being read, and yanking somebody to Home because they tidied up
   * a recording would be the navigation nobody asked for.
   */
  function handleDiscard() {
    recorder.reset();
    if (pathname === "/record") router.push("/home");
  }


  const shell = React.useRef<HTMLDivElement>(null);
  usePublishedHeight(shell, recorder.state !== "idle" || phase !== "idle");

  async function handleSave() {
    if (!recorder.result) return;
    // What was typed at the top of the page, or the date if nothing was. The
    // field is offered rather than demanded precisely so this fallback exists:
    // a recording arrives as `recording-1755084000000.webm`, which is not a
    // name for anything.
    await job.save(recorder.result, session.title.trim() || defaultRecordingTitle());
  }

  // Not just "is something being recorded" any more: the pipeline runs after
  // the recorder has been let go, and that is the stretch this bar now covers.
  if (recorder.state === "idle" && phase === "idle") return null;

  return (
    /*
     * `left-0 right-0` centres this on the viewport, which is not where the
     * page is. On a wide screen the rail takes the first 16rem of it, so a bar
     * centred on the window sits visibly left of the column it belongs to —
     * the width of half a sidebar, which reads as a mistake rather than a
     * choice. Offsetting by the rail lines it up with what it controls.
     */
    <div
      ref={shell}
      className="pointer-events-none fixed bottom-0 left-0 right-0 z-30 flex flex-col items-center gap-2 p-3 sm:p-4 lg:left-64"
    >
      <NoAudioNotice />

      <div
        role="region"
        aria-label="Recording controls"
        className="pointer-events-auto w-auto max-w-full rounded-2xl border bg-card/95 px-4 py-3 shadow-lg backdrop-blur"
      >
        {/* Inside the card, not floating above it. On the page background this
            sat over the transcript with nothing behind it, so the newest thing
            somebody said was crossed out by a standing instruction.

            Recallix has no bot to announce itself in a participant list, so the
            only thing that tells the room is the person holding this. */}
        <p className="mb-2 text-center text-[11px] text-muted-foreground">
          Always ask permission before recording
        </p>

        {/* The waveform spans the card, so the thing that proves audio is
            arriving is the widest element here rather than a detail beside the
            microphone. */}
        {live && <Waveform level={recorder.level} active={recorder.state === "recording"} />}

        {/*
         * One centred row, and the bar itself only as wide as it.
         *
         * This was a three-column grid, on the theory that the transport should
         * hold the middle while the pickers sat left and the toggle right. It
         * did not: `1fr` is `minmax(auto, 1fr)`, so the left track grew to fit
         * two dropdowns, the right one could not match it, and the whole row
         * ended up shouldered left inside a bar that stayed full width. The
         * dead space on the right was the give-away.
         *
         * Sizing the bar to its contents removes the problem rather than
         * correcting for it: there is no leftover width for anything to be
         * off-centre within.
         */}
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-3">
          <div className="flex items-center gap-3">
            {/* No microphone once there is nothing to point one at. Left up
                after Stop it would look like it governed the recording sitting
                beside it waiting to be saved, when all it can do is arm the
                next one. The language does still reach this recording — that is
                resolved when the meeting is enqueued, which is on Save. */}
            {recorder.state === "recording" || recorder.state === "paused" || recorder.state === "requesting" ? (
              <MicrophonePicker />
            ) : null}
            {/* The transcript language used to sit here, beside the
                microphone, and it is gone. It never configured this recording:
                it wrote the account default, which is resolved when a meeting
                is enqueued — so it was an account setting wearing the clothes
                of a control over the thing in front of you, and it stayed on
                screen after Stop where there was nothing left for it to
                affect. It lives in Settings and on the import dialog, both of
                which are honest about being about the account. */}
          </div>

          {recorder.state === "requesting" && (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Waiting for permission…
            </span>
          )}

          {live && (
            <div className="flex items-center gap-3">
              {recorder.state === "recording" ? (
                <Button variant="outline" size="sm" className="gap-2" onClick={recorder.pause}>
                  <Pause className="h-4 w-4" /> Pause
                </Button>
              ) : (
                <Button variant="outline" size="sm" className="gap-2" onClick={recorder.resume}>
                  <Play className="h-4 w-4" /> Resume
                </Button>
              )}

              <span
                className="font-mono text-sm tabular-nums"
                aria-label={`Recorded so far: ${stopwatch(recorder.elapsed)}`}
              >
                {stopwatch(recorder.elapsed)}
              </span>

              <Button size="sm" variant="destructive" className="gap-2" onClick={recorder.stop}>
                <Square className="h-4 w-4" /> Stop
              </Button>
            </div>
          )}

          {unsaved && recorder.result && (
            <div className="flex flex-wrap items-center justify-center gap-3">
              <span className="text-sm text-muted-foreground">
                {empty ? (
                  <span className="flex items-center gap-1.5 text-destructive">
                    <AlertTriangle className="h-4 w-4" />
                    No audio was captured — the recording was stopped too soon.
                  </span>
                ) : (
                  <>
                    {stopwatch(recorder.result.durationSeconds)} ·{" "}
                    {(recorder.result.file.size / 1024 / 1024).toFixed(1)} MB
                  </>
                )}
              </span>
              {/* Rendered whether or not something is in flight, and disabled
                  rather than removed. A control that vanishes while the thing
                  it would cancel is running leaves somebody looking at a bar
                  with one disabled button on it and no way out — which is what
                  a stuck phase used to produce, and what made a bug about
                  state look like a bug about Discard. */}
              <Button
                variant="ghost"
                size="sm"
                className="gap-2"
                disabled={busy}
                onClick={handleDiscard}
              >
                <RotateCcw className="h-4 w-4" /> Discard
              </Button>
              {/* Nothing to send, so nothing to offer. */}
              {!empty && (
                <Button size="sm" className="gap-2" disabled={busy} onClick={() => void handleSave()}>
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <UploadCloud className="h-4 w-4" />
                  )}
                  {busy ? "Working…" : "Save & process"}
                </Button>
              )}
            </div>
          )}

          {phase === "processing" && job && (
            <div className="flex items-center justify-center gap-3">
              {/* The one control, as a glyph. The words are on the bar below —
                  saying them twice in one card reads as two different things
                  happening — and this is the shape a stop is: a square, in the
                  same red as the one that ends a recording.

                  Named for what it does to the meeting rather than to the
                  worker, which cannot be recalled. "Stop processing" that left
                  a half-finished meeting in the list would tidy nothing. */}
              <Button
                variant="destructive"
                size="icon"
                className="h-8 w-8 rounded-full"
                disabled={stopping}
                onClick={() => void handleStop()}
                aria-label="Stop processing"
                title="Stop processing"
              >
                {stopping ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Square className="h-3.5 w-3.5 fill-current" />
                )}
              </Button>
            </div>
          )}

        </div>

        {/* One bar across both halves of the wait. See UPLOAD_SHARE: an upload
            bar that fills and then a pipeline bar that starts again from zero
            reads as the first one having been thrown away. */}
        {(working || phase === "done") && (
          <div className="mt-3 space-y-1.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{label}</span>
              <span className="tabular-nums">{overallProgress}%</span>
            </div>
            <Progress value={overallProgress} />
          </div>
        )}

        {recorder.error && <p className="mt-3 text-xs text-destructive">{recorder.error}</p>}
      </div>
    </div>
  );
}

/**
 * Tell the rest of the page how much room to leave.
 *
 * The bar changes height as a recording goes on — the waveform arrives with the
 * first frame, the no-audio warning stacks above it, a progress bar opens below
 * it on save — and anything that guessed a single number cut off whatever
 * happened to be at the bottom of the page. That is always the newest line of
 * the transcript, which is the line being read.
 *
 * Published as a custom property on the root so the shell can spend it as
 * padding without the two components having to know about each other. Cleared
 * on the way out, or every page in the app keeps a hole at the bottom for a bar
 * that is no longer there.
 */
function usePublishedHeight(ref: React.RefObject<HTMLElement>, showing: boolean) {
  React.useEffect(() => {
    const node = ref.current;
    const root = document.documentElement;
    if (!node || !showing) {
      root.style.removeProperty("--recording-bar");
      return;
    }
    const publish = () => root.style.setProperty("--recording-bar", `${node.offsetHeight}px`);
    publish();

    // jsdom has no ResizeObserver, and neither do a couple of browsers we do
    // not gate on. The measurement above is still right for the common case.
    if (typeof ResizeObserver === "undefined") return () => root.style.removeProperty("--recording-bar");
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--recording-bar");
    };
  }, [ref, showing]);
}

/* --------------------------------- pieces -------------------------------- */

/** What a microphone is called, given the browser may not have said. */
function deviceName(device: MediaDeviceInfo, index: number): string {
  // Labels are blank until permission is granted, and a blank option is
  // unpickable in every sense that matters.
  return device.label || `Microphone ${index + 1}`;
}

/**
 * Which microphone, hung off the microphone.
 *
 * <p>This was a select the width of a device name, sitting beside a mic glyph
 * that did nothing — two objects saying "microphone" where one would do, and
 * the wider of them was the one carrying no information most of the time,
 * because the answer is "System default" for nearly everybody. The glyph is the
 * control now, and the name is a tooltip on it.
 *
 * <p>The four-bar meter that sat beside it is gone too. It answered a real
 * question — did that change work? — but the waveform spanning this card
 * answers the same one across the full width, and only while there is something
 * to answer it about. Two meters for one input is one more than the input has.
 */
function MicrophonePicker() {
  const recorder = useRecording();
  const chosen = recorder.devices.findIndex((d) => d.deviceId === recorder.deviceId);
  const current =
    chosen >= 0 ? deviceName(recorder.devices[chosen], chosen) : "System default";

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 gap-1 px-2 text-muted-foreground hover:text-foreground"
            aria-label="Microphone"
            // The name is here rather than on screen: it is worth having, and
            // not worth the width of the bar to say on every recording.
            title={`Microphone: ${current}`}
          >
            <Mic className="h-4 w-4" />
            {/* The only thing on the glyph that says it opens anything. */}
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        {/* Upward, because the bar is docked to the bottom of the window. */}
        <DropdownMenuContent side="top" align="start" className="w-56">
          <DropdownMenuItem onSelect={() => recorder.setDeviceId(null)}>
            <Check
              className={cn("h-4 w-4", recorder.deviceId ? "opacity-0" : "opacity-100")}
            />
            System default
          </DropdownMenuItem>
          {recorder.devices.map((device, index) => (
            <DropdownMenuItem
              key={device.deviceId}
              onSelect={() => recorder.setDeviceId(device.deviceId)}
            >
              <Check
                className={cn(
                  "h-4 w-4",
                  recorder.deviceId === device.deviceId ? "opacity-100" : "opacity-0",
                )}
              />
              {deviceName(device, index)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * The input, drawn across the width of the bar.
 *
 * Sampled on a timer rather than off every render. `level` updates once per
 * animation frame, and a waveform rebuilt sixty times a second costs far more
 * than it shows — the eye cannot read sixty distinct bars a second, and this
 * runs for the length of a meeting. Twelve samples a second looks continuous
 * and leaves the frame budget to the rest of the page.
 *
 * It scrolls right to left, so the newest sound is nearest the controls.
 */
function Waveform({ level, active }: { level: number; active: boolean }) {
  const SAMPLES = 56;
  const [bars, setBars] = React.useState<number[]>(() => new Array(SAMPLES).fill(0));
  const latest = React.useRef(level);
  latest.current = level;

  React.useEffect(() => {
    if (!active) {
      // Flat, not frozen. A waveform holding its last shape through a pause
      // reads as a signal that has stopped moving rather than one nobody is
      // recording.
      setBars(new Array(SAMPLES).fill(0));
      return;
    }
    const id = setInterval(() => {
      setBars((prev) => [...prev.slice(1), latest.current]);
    }, 80);
    return () => clearInterval(id);
  }, [active]);

  return (
    <div aria-hidden className="mb-3 flex h-5 items-center justify-center gap-[3px]">
      {bars.map((value, i) => (
        <span
          key={i}
          className={cn(
            "w-[2px] rounded-full",
            value > 0.02 ? "bg-destructive/70" : "bg-muted-foreground/20",
          )}
          // A floor of 2px so silence is a dotted line rather than a gap, which
          // is what the bar looks like before anybody has said anything.
          style={{ height: `${Math.max(2, Math.min(20, value * 26))}px` }}
        />
      ))}
    </div>
  );
}

/**
 * "No audio is being captured".
 *
 * The failure this exists for is the quiet one: permission granted, recording
 * running, timer counting, and nothing arriving — a muted headset, a hardware
 * switch, or the wrong input selected. Nothing else in the interface
 * contradicts it, so without this the meeting is found to be silent after it is
 * over, which is the one moment at which nothing can be done about it.
 *
 * Dismissible, and re-armed when sound returns: somebody genuinely recording a
 * silent room should be able to make it go away, and somebody who has just
 * fixed their microphone should not be left wondering whether it is stale.
 */
function NoAudioNotice() {
  const recorder = useRecording();
  const silent =
    recorder.state === "recording" && recorder.silentSeconds >= SILENCE_GRACE_SECONDS;
  const [dismissed, setDismissed] = React.useState(false);

  React.useEffect(() => {
    if (!silent) setDismissed(false);
  }, [silent]);

  if (!silent || dismissed) return null;

  return (
    <div
      role="status"
      className="pointer-events-auto w-full max-w-3xl rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300 shadow-lg backdrop-blur"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">No audio is being captured</p>
          <ul className="mt-1 space-y-0.5 text-xs">
            <li>Check that your microphone isn&apos;t muted</li>
            <li>If you&apos;re using headphones, try your device&apos;s built-in mic instead</li>
            <li>Check that another app hasn&apos;t taken the microphone</li>
          </ul>
          {/* Said plainly, because the alternative is somebody stopping a
              recording that was half working and losing the half that worked. */}
          <p className="mt-1.5 text-xs">
            The recording is still running, and anything captured before this is kept.
          </p>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setDismissed(true)}
          className="rounded p-0.5 hover:bg-amber-500/20"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
