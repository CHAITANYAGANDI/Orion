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
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Mic,
  Pause,
  Play,
  Square,
  Globe,
  Loader2,
  UploadCloud,
  RotateCcw,
  X,
  AlertTriangle,
} from "lucide-react";
import {
  useCreateUploadUrlMutation,
  useCreateMeetingMutation,
  useGetLanguagesQuery,
  useGetPreferencesQuery,
  useUpdatePreferencesMutation,
} from "@/lib/api";
import { useRecording, useRecordingSession } from "@/lib/recording-context";
import { putWithProgress, uploadError } from "@/lib/uploads";
import { stopwatch } from "@/lib/format";
import { Button } from "@/components/ui/button";
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

type Phase = "idle" | "uploading" | "creating";

export function RecordingBar() {
  const recorder = useRecording();
  const session = useRecordingSession();
  const router = useRouter();
  const [createUploadUrl] = useCreateUploadUrlMutation();
  const [createMeeting] = useCreateMeetingMutation();

  const [phase, setPhase] = React.useState<Phase>("idle");
  const [progress, setProgress] = React.useState(0);

  const busy = phase !== "idle";
  const live = recorder.state === "recording" || recorder.state === "paused";
  const unsaved = recorder.state === "stopped" && recorder.result !== null;

  const shell = React.useRef<HTMLDivElement>(null);
  usePublishedHeight(shell, recorder.state !== "idle");

  async function handleSave() {
    if (!recorder.result) return;
    const { file, durationSeconds } = recorder.result;
    try {
      setPhase("uploading");
      setProgress(5);
      const presign = await createUploadUrl({
        filename: file.name,
        contentType: file.type,
        sizeBytes: file.size,
      }).unwrap();

      await putWithProgress(presign.uploadUrl, file, (pct) => setProgress(Math.max(5, pct)));

      setPhase("creating");
      const meeting = await createMeeting({
        objectKey: presign.objectKey,
        // What was typed at the top of the page, or the date if nothing was.
        // The field is offered rather than demanded precisely so that this
        // fallback exists: a recording arrives as
        // `recording-1755084000000.webm`, which is not a name for anything.
        title: session.title.trim() || defaultRecordingTitle(),
        contentType: file.type,
        durationSeconds: durationSeconds || undefined,
        // Not sent, deliberately.
        //
        // This used to be `true`, and that was sound while it was: recording
        // could not start until the box was ticked, so a recording that existed
        // was proof one had been. The box is gone, so the proof is gone with
        // it, and sending `true` anyway would write a timestamp into
        // `consent_confirmed_at` recording a statement nobody made — which the
        // privacy overview then counts and reports back as fact. Omitting it
        // leaves the column null, which is what "nobody said" looks like.
        // Which of the two clients captured this, and nothing more. It is what
        // lets "email me my meeting summaries" mean recordings without also
        // meaning every file somebody imports.
        recorded: true,
      }).unwrap();

      recorder.reset();
      toast.success("Recording saved — processing started.");
      router.push(`/meetings/${meeting.id}`);
    } catch (err) {
      setPhase("idle");
      setProgress(0);
      toast.error(uploadError(err));
    }
  }

  if (recorder.state === "idle") return null;

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
            {recorder.state !== "stopped" && <MicrophonePicker />}
            <TranscriptLanguagePicker />
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
                {stopwatch(recorder.result.durationSeconds)} ·{" "}
                {(recorder.result.file.size / 1024 / 1024).toFixed(1)} MB
              </span>
              {!busy && (
                <Button variant="ghost" size="sm" className="gap-2" onClick={recorder.reset}>
                  <RotateCcw className="h-4 w-4" /> Discard
                </Button>
              )}
              <Button size="sm" className="gap-2" disabled={busy} onClick={() => void handleSave()}>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <UploadCloud className="h-4 w-4" />
                )}
                {busy ? "Working…" : "Save & process"}
              </Button>
            </div>
          )}

        </div>

        {busy && (
          <div className="mt-3 space-y-1.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{phase === "uploading" ? "Uploading…" : "Starting processing…"}</span>
              <span>{progress}%</span>
            </div>
            <Progress value={phase === "creating" ? 100 : progress} />
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

/**
 * Which microphone, with a meter beside it.
 *
 * The meter is why the picker belongs here rather than in settings: it is the
 * only thing that turns "I think I chose the headset" into something visible,
 * and it answers the question a picker raises the moment you use it — did that
 * work?
 */
function MicrophonePicker() {
  const recorder = useRecording();

  return (
    <div className="flex items-center gap-2">
      <Mic className="h-4 w-4 shrink-0 text-muted-foreground" />
      <InputLevel level={recorder.level} active={recorder.state === "recording"} />
      <label className="sr-only" htmlFor="recording-microphone">
        Microphone
      </label>
      <select
        id="recording-microphone"
        value={recorder.deviceId ?? ""}
        onChange={(e) => recorder.setDeviceId(e.target.value || null)}
        className="h-8 max-w-[10rem] rounded-md border bg-background px-2 text-xs"
      >
        <option value="">System default</option>
        {recorder.devices.map((device, index) => (
          <option key={device.deviceId} value={device.deviceId}>
            {/* Labels are blank until permission is granted, and a blank option
                is unpickable in every sense that matters. */}
            {device.label || `Microphone ${index + 1}`}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The language transcription will assume.
 *
 * An account setting, shown where it is needed. Unlike the import dialog's copy
 * of this, it does reach the recording in progress: the language is resolved
 * when the meeting is enqueued, which for a recording is after Stop.
 */
function TranscriptLanguagePicker() {
  const languages = useGetLanguagesQuery();
  const prefs = useGetPreferencesQuery();
  const [update] = useUpdatePreferencesMutation();

  async function save(code: string) {
    try {
      await update({ defaultLanguage: code }).unwrap();
    } catch (err) {
      toast.error(uploadError(err));
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
      <label className="sr-only" htmlFor="recording-language">
        Transcript language
      </label>
      <select
        id="recording-language"
        value={prefs.data?.defaultLanguage ?? ""}
        onChange={(e) => void save(e.target.value)}
        className="h-8 max-w-[10rem] rounded-md border bg-background px-2 text-xs"
      >
        <option value="">Detect automatically</option>
        {(languages.data ?? []).map((l) => (
          <option key={l.code} value={l.code}>
            {l.name}
          </option>
        ))}
      </select>
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

/** Four bars that move with the input, so silence looks like silence. */
function InputLevel({ level, active }: { level: number; active: boolean }) {
  return (
    <span aria-hidden className="flex h-4 items-end gap-0.5">
      {[0.15, 0.4, 0.65, 0.9].map((threshold) => (
        <span
          key={threshold}
          className={cn(
            "w-0.5 rounded-full transition-colors duration-75",
            active && level >= threshold ? "bg-destructive" : "bg-muted-foreground/25",
          )}
          style={{ height: `${25 + threshold * 75}%` }}
        />
      ))}
    </span>
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
      className="pointer-events-auto w-full max-w-3xl rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 shadow-lg backdrop-blur dark:text-amber-300"
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
