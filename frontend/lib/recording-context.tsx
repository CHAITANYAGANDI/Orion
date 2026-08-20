"use client";

/**
 * One recorder for the whole app, owned above the router.
 *
 * `useRecorder` tears down its streams when the component holding it unmounts.
 * While that hook lived on the record page, client-side navigation destroyed a
 * live recording: clicking any sidebar link unmounted the page, stopped the
 * microphone, and dropped every chunk captured so far. Nothing failed loudly —
 * the recording simply ceased to exist, and the user found out when they came
 * back to a reset page.
 *
 * Hoisting it into the app-group layout, which stays mounted across every
 * in-app route change, means recording continues while you look something up.
 * It also gives the shell somewhere to read from, so the indicator and timer
 * can follow you around the app instead of living on one page.
 *
 * What this still cannot survive is the tab closing or reloading — the audio
 * only exists in memory. `useUnloadGuard` turns that into a browser
 * "leave site?" prompt rather than a silent loss.
 */

import * as React from "react";
import { useRecorder, type UseRecorder } from "@/lib/use-recorder";
import { useSaveJob, type UseSaveJob } from "@/lib/use-save-job";
import { useLiveTranscript, type UseLiveTranscript } from "@/lib/use-live-transcript";

const RecordingContext = React.createContext<UseRecorder | null>(null);

/**
 * What is being recorded, as opposed to the machinery recording it.
 *
 * The name somebody is typing and the words appearing under it belong to the
 * meeting, not to the `MediaRecorder`, but they need the same thing the
 * recorder needed: to outlive the page. A title typed on /record and lost by
 * glancing at Home is worse than no title field, because the work disappears
 * without anything having gone wrong.
 */
export interface RecordingSession {
  /** What the user has typed, or empty for the date-stamped default. */
  title: string;
  setTitle: (t: string) => void;
  transcript: UseLiveTranscript;
}

const SessionContext = React.createContext<RecordingSession | null>(null);

/**
 * The upload and the pipeline that follows it.
 *
 * <p>Held here for the same reason the recorder is: two things show it. The
 * docked bar carries the controls, the record page draws the stages, and an
 * upload owned by either of them would be a second upload as soon as the other
 * rendered.
 */
const SaveJobContext = React.createContext<UseSaveJob | null>(null);

export function RecordingProvider({ children }: { children: React.ReactNode }) {
  const recorder = useRecorder();
  const [title, setTitle] = React.useState("");
  const transcript = useLiveTranscript({
    // Running *or* paused. A pause mutes the audio tap rather than closing the
    // session, so the speaker model built up over the meeting so far survives
    // somebody stepping out for a minute -- and the words already on screen
    // stay on screen.
    active: recorder.state === "recording" || recorder.state === "paused",
    // Paused means paused. Audio streamed through a pause would put words into
    // the transcript for the exact stretch the user stopped it being recorded.
    paused: recorder.state === "paused",
    // The recorder's own graph. Not a second microphone -- see the note on
    // `liveSource` in lib/use-recorder.ts for the bug that closes.
    source: recorder.liveSource,
    elapsed: recorder.elapsed,
  });

  // A finished session leaves nothing behind for the next one.
  //
  // On the *transition* back to idle, not on being idle: a title can be typed
  // before pressing Start, and clearing whenever the recorder happens to be
  // idle would delete it a character at a time as it was typed.
  const idle = recorder.state === "idle";
  const wasIdle = React.useRef(idle);
  const clearTranscript = transcript.clear;
  React.useEffect(() => {
    if (idle && !wasIdle.current) {
      setTitle("");
      clearTranscript();
    }
    wasIdle.current = idle;
  }, [idle, clearTranscript]);

  const job = useSaveJob(recorder);

  useUnloadGuard(recorder);
  return (
    <RecordingContext.Provider value={recorder}>
      <SessionContext.Provider value={{ title, setTitle, transcript }}>
        <SaveJobContext.Provider value={job}>{children}</SaveJobContext.Provider>
      </SessionContext.Provider>
    </RecordingContext.Provider>
  );
}

/** The upload and pipeline for the recording that was just saved. */
export function useRecordingJob(): UseSaveJob {
  const ctx = React.useContext(SaveJobContext);
  if (!ctx) {
    throw new Error("useRecordingJob must be used inside <RecordingProvider>");
  }
  return ctx;
}

/** The title and the live text for the recording in progress. */
export function useRecordingSession(): RecordingSession {
  const ctx = React.useContext(SessionContext);
  if (!ctx) {
    throw new Error("useRecordingSession must be used inside <RecordingProvider>");
  }
  return ctx;
}

/**
 * The app-wide recorder.
 *
 * Throws outside the provider rather than falling back to a fresh recorder: a
 * silent second instance would record in parallel, fight over the microphone,
 * and leave the indicator tracking a different recording from the one the page
 * is showing.
 */
export function useRecording(): UseRecorder {
  const ctx = React.useContext(RecordingContext);
  if (!ctx) {
    throw new Error("useRecording must be used inside <RecordingProvider>");
  }
  return ctx;
}

/** True when audio would be lost by leaving now. */
export function hasUnsavedAudio(r: UseRecorder): boolean {
  return r.state === "recording" || r.state === "paused" || r.result !== null;
}

/**
 * Ask the browser to confirm before unloading with audio still in memory.
 *
 * Modern browsers ignore the message text and show their own wording, and only
 * honour the prompt at all if the user has interacted with the page — which,
 * having pressed Record, they have.
 */
function useUnloadGuard(recorder: UseRecorder) {
  const atRisk = hasUnsavedAudio(recorder);

  React.useEffect(() => {
    if (!atRisk) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy browsers require a returnValue to trigger the prompt.
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [atRisk]);
}
