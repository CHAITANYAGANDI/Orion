"use client";

/**
 * Words on screen while somebody is still saying them.
 *
 * This is **not** the transcript. Recallix's transcript is made after Stop, by
 * the speech-to-text provider named on the Security tab, from the audio file
 * the browser uploads — that is the one that gets diarised, summarised, chunked
 * for chat and kept. What this produces is a preview: unpunctuated in places,
 * wrong about names, and thrown away when the recording ends.
 *
 * It is worth having anyway, because the alternative is a blank page. A meeting
 * being recorded with nothing moving on screen is indistinguishable from a
 * meeting that is not being recorded, and the way people resolve that doubt is
 * by stopping to check.
 *
 * ## It runs whenever a recording does
 *
 * There was a switch, and it was in the way: words that only appear after you
 * find a toggle are words you do not see during the meeting you were trying to
 * follow, which is the only meeting they are any use for.
 *
 * `SpeechRecognition` is not local, though — Chrome streams the audio to
 * Google, Safari to Apple — and Recallix tells people exactly which third
 * parties hear their meetings. With no switch to hang it on, that disclosure
 * moves to the place somebody reads before starting: the notice above the
 * consent tick, which is already the paragraph about who hears this recording.
 *
 * ## Browser reality
 *
 *  - Firefox does not implement it. `supported` is false and the caller says so
 *    rather than showing a control that does nothing.
 *  - Chrome ends the session after a stretch of silence, whatever `continuous`
 *    claims, so `onend` restarts it. Without that the live text simply stops
 *    partway through a meeting and never explains itself.
 *  - `start()` on an already-started recogniser throws, hence `runningRef`.
 *  - It opens its own microphone stream and ignores the device chosen in the
 *    bar. Nothing can be done about that from here; it affects the preview
 *    only, never the recording, which is on the stream the recorder owns.
 */

import * as React from "react";

/** One finished phrase, stamped with where it fell in the recording. */
export interface LivePhrase {
  id: number;
  /** Seconds into the recording, matching the timeline the player will use. */
  at: number;
  text: string;
}

export interface UseLiveTranscript {
  /** False in browsers with no speech recognition at all — Firefox, notably. */
  supported: boolean;
  phrases: LivePhrase[];
  /** The phrase currently being spoken, which will change before it settles. */
  interim: string;
  error: string | null;
  clear: () => void;
}

/* -------------------------------------------------------------------------- */
/* The parts of the Web Speech API this uses, which lib.dom does not declare.  */
/* -------------------------------------------------------------------------- */

interface SpeechAlternative {
  transcript: string;
}
interface SpeechResult {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: SpeechAlternative;
}
interface SpeechResultList {
  readonly length: number;
  [index: number]: SpeechResult;
}
interface SpeechResultEvent extends Event {
  resultIndex: number;
  results: SpeechResultList;
}
interface SpeechErrorEvent extends Event {
  error: string;
}
interface SpeechRecogniser {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
}
type RecogniserConstructor = new () => SpeechRecogniser;

function recogniserConstructor(): RecogniserConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecogniserConstructor;
    webkitSpeechRecognition?: RecogniserConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useLiveTranscript({
  active,
  elapsed,
  lang,
}: {
  /** Recognition runs only while this is true — a paused meeting is not live. */
  active: boolean;
  /** Seconds recorded so far, used to stamp each phrase. */
  elapsed: number;
  /** BCP-47-ish tag from the account's transcript language; blank auto-detects. */
  lang: string | null;
}): UseLiveTranscript {
  const [supported, setSupported] = React.useState(false);
  const [phrases, setPhrases] = React.useState<LivePhrase[]>([]);
  const [interim, setInterim] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const recogniserRef = React.useRef<SpeechRecogniser | null>(null);
  const runningRef = React.useRef(false);
  const wantRunningRef = React.useRef(false);
  // `onresult` is installed once and would otherwise close over the elapsed
  // value from the render that installed it, stamping every phrase with 0.
  const elapsedRef = React.useRef(0);
  // When the phrase now being spoken began, so it is timed from its first word
  // rather than from the moment the recogniser decided it had finished.
  const phraseStartRef = React.useRef<number | null>(null);
  const nextIdRef = React.useRef(1);

  elapsedRef.current = elapsed;

  // Read once on the client: deciding this during render would differ from the
  // server, where there is no `window` to ask.
  React.useEffect(() => {
    setSupported(recogniserConstructor() !== null);
  }, []);

  const clear = React.useCallback(() => {
    setPhrases([]);
    setInterim("");
    phraseStartRef.current = null;
  }, []);

  React.useEffect(() => {
    const Recogniser = recogniserConstructor();
    if (!Recogniser || !active) {
      // Falling out of `active` covers Pause and Stop alike: the recogniser is
      // torn down rather than left listening to a meeting nobody is recording.
      wantRunningRef.current = false;
      if (recogniserRef.current && runningRef.current) {
        recogniserRef.current.onend = null;
        recogniserRef.current.abort();
      }
      recogniserRef.current = null;
      runningRef.current = false;
      setInterim("");
      return;
    }

    const recogniser = new Recogniser();
    recogniser.continuous = true;
    recogniser.interimResults = true;
    // Blank means auto-detect for Recallix's own transcript, but the browser
    // has no such option, so the page language is the closest honest default.
    if (lang) recogniser.lang = lang;

    recogniser.onresult = (event) => {
      let pending = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) {
          const trimmed = text.trim();
          if (trimmed) {
            const at = phraseStartRef.current ?? elapsedRef.current;
            setPhrases((prev) => [...prev, { id: nextIdRef.current++, at, text: trimmed }]);
          }
          phraseStartRef.current = null;
        } else {
          pending += text;
        }
      }
      if (pending && phraseStartRef.current === null) {
        phraseStartRef.current = elapsedRef.current;
      }
      setInterim(pending.trim());
    };

    recogniser.onerror = (event) => {
      // Silence and self-inflicted stops are ordinary traffic, not faults.
      if (event.error === "no-speech" || event.error === "aborted") return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        wantRunningRef.current = false;
        setError("Live text needs microphone access in this browser.");
        return;
      }
      setError("Live text stopped. The recording is not affected.");
    };

    recogniser.onend = () => {
      runningRef.current = false;
      // Chrome ends the session after a pause in the talking whatever
      // `continuous` says. Restarting is the difference between live text that
      // works for an hour and live text that works for the first minute.
      if (!wantRunningRef.current) return;
      try {
        recogniser.start();
        runningRef.current = true;
      } catch {
        /* Already restarting, or gone. */
      }
    };

    wantRunningRef.current = true;
    try {
      recogniser.start();
      runningRef.current = true;
      recogniserRef.current = recogniser;
      setError(null);
    } catch {
      setError("Live text couldn't start. The recording is not affected.");
    }

    return () => {
      wantRunningRef.current = false;
      recogniser.onend = null;
      recogniser.onresult = null;
      recogniser.onerror = null;
      try {
        recogniser.abort();
      } catch {
        /* Already gone. */
      }
      runningRef.current = false;
      recogniserRef.current = null;
    };
  }, [active, lang]);

  return { supported, phrases, interim, error, clear };
}
