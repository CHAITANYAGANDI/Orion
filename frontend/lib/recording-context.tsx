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

const RecordingContext = React.createContext<UseRecorder | null>(null);

export function RecordingProvider({ children }: { children: React.ReactNode }) {
  const recorder = useRecorder();
  useUnloadGuard(recorder);
  return <RecordingContext.Provider value={recorder}>{children}</RecordingContext.Provider>;
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
