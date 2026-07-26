"use client";

/**
 * In-browser meeting capture: the other participants plus you.
 *
 * A microphone-only recording is useless for a meeting — it captures your voice
 * and nothing anyone else said. So this grabs two sources and mixes them:
 *
 *   1. **Tab audio** via `getDisplayMedia`, which is what carries the remote
 *      participants out of Meet/Zoom/Teams running in another tab.
 *   2. **Your microphone** via `getUserMedia`.
 *
 * Both are routed through a single `AudioContext` into one
 * `MediaStreamAudioDestinationNode`, so `MediaRecorder` sees one mixed track
 * and the output needs no post-processing before it hits the normal upload path.
 *
 * Browser reality this has to cope with:
 *  - `getDisplayMedia` only offers audio when the user picks a **tab** and ticks
 *    "share tab audio". Picking a window or screen yields video only.
 *  - Chromium requires `video: true` to offer the audio checkbox at all, so the
 *    video track is requested and then immediately stopped.
 *  - Firefox and Safari do not provide display audio. Capture degrades to
 *    mic-only rather than failing, and `hasTabAudio` reports what actually
 *    happened so the UI can tell the truth.
 */

import * as React from "react";

export type RecorderState = "idle" | "requesting" | "recording" | "paused" | "stopped";

export interface RecorderResult {
  file: File;
  durationSeconds: number;
  /** False when only the microphone was captured. */
  hadTabAudio: boolean;
}

export interface UseRecorder {
  state: RecorderState;
  /** Whole seconds of audio actually recorded (excludes paused time). */
  elapsed: number;
  /** 0–1 input level, for the meter. */
  level: number;
  error: string | null;
  hasTabAudio: boolean;
  result: RecorderResult | null;
  supported: boolean;
  start: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  reset: () => void;
}

/** Preferred container/codec, in descending order of quality. */
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

export function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "audio/webm";
  for (const type of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "audio/webm";
}

export function extensionFor(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "m4a";
  return "webm";
}

export function useRecorder(): UseRecorder {
  const [state, setState] = React.useState<RecorderState>("idle");
  const [elapsed, setElapsed] = React.useState(0);
  const [level, setLevel] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [hasTabAudio, setHasTabAudio] = React.useState(false);
  const [result, setResult] = React.useState<RecorderResult | null>(null);

  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const streamsRef = React.useRef<MediaStream[]>([]);
  const audioCtxRef = React.useRef<AudioContext | null>(null);
  const analyserRef = React.useRef<AnalyserNode | null>(null);
  const rafRef = React.useRef<number | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const hadTabAudioRef = React.useRef(false);
  // Mirrors `elapsed` so `recorder.onstop` reads the final value rather than the
  // stale one captured when the handler was defined.
  const elapsedRef = React.useRef(0);

  const supported =
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia;

  /** Release every track, node and timer. Safe to call repeatedly. */
  const teardown = React.useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    streamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    streamsRef.current = [];
    analyserRef.current = null;
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {
        /* already closed */
      });
      audioCtxRef.current = null;
    }
    setLevel(0);
  }, []);

  React.useEffect(() => teardown, [teardown]);

  const start = React.useCallback(async () => {
    if (!supported) {
      setError("This browser can't record audio. Try Chrome or Edge.");
      return;
    }

    setError(null);
    setResult(null);
    setElapsed(0);
    setState("requesting");
    hadTabAudioRef.current = false;

    const sources: MediaStream[] = [];
    let micStream: MediaStream;

    // 1) Microphone first — without it there is nothing worth recording, so a
    //    denial here is fatal whereas a display-capture denial is not.
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      sources.push(micStream);
    } catch {
      setState("idle");
      setError("Microphone access was denied. Recallix needs it to record you.");
      return;
    }

    // 2) Tab audio. Optional: several browsers cannot provide it, and the user
    //    may share a window (video only) or cancel outright.
    let displayStream: MediaStream | null = null;
    try {
      if (navigator.mediaDevices.getDisplayMedia) {
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          // Chromium only offers the "share tab audio" checkbox when video is
          // requested; the video track is discarded immediately below.
          video: true,
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        displayStream.getVideoTracks().forEach((t) => t.stop());
        if (displayStream.getAudioTracks().length > 0) {
          hadTabAudioRef.current = true;
          sources.push(displayStream);
        }
      }
    } catch {
      // Cancelled or unsupported — carry on with mic only.
      displayStream = null;
    }

    streamsRef.current = displayStream ? [micStream, displayStream] : [micStream];
    setHasTabAudio(hadTabAudioRef.current);

    // 3) Mix every source into one track.
    const AudioCtx: typeof AudioContext =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    audioCtxRef.current = ctx;
    const destination = ctx.createMediaStreamDestination();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyserRef.current = analyser;

    for (const stream of sources) {
      if (stream.getAudioTracks().length === 0) continue;
      const source = ctx.createMediaStreamSource(stream);
      source.connect(destination);
      source.connect(analyser);
    }

    // 4) Record the mixed track.
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(destination.stream, { mimeType });
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      const file = new File([blob], `recording-${Date.now()}.${extensionFor(mimeType)}`, {
        type: mimeType,
      });
      setResult({
        file,
        durationSeconds: elapsedRef.current,
        hadTabAudio: hadTabAudioRef.current,
      });
      setState("stopped");
      teardown();
    };

    // Stopping the share from the browser's own bar must end the recording too,
    // otherwise we would silently keep taping just the microphone.
    displayStream?.getAudioTracks().forEach((track) => {
      track.onended = () => {
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
          recorderRef.current.stop();
          recorderRef.current = null;
        }
      };
    });

    // 1s timeslices keep memory bounded on long meetings.
    recorder.start(1000);
    recorderRef.current = recorder;
    setState("recording");

    timerRef.current = setInterval(() => {
      setElapsed((s) => {
        elapsedRef.current = s + 1;
        return s + 1;
      });
    }, 1000);

    const meter = () => {
      const node = analyserRef.current;
      if (!node) return;
      const buffer = new Uint8Array(node.frequencyBinCount);
      node.getByteTimeDomainData(buffer);
      // RMS around the 128 midpoint of unsigned 8-bit PCM.
      let sum = 0;
      for (const v of buffer) {
        const centred = (v - 128) / 128;
        sum += centred * centred;
      }
      setLevel(Math.min(1, Math.sqrt(sum / buffer.length) * 3));
      rafRef.current = requestAnimationFrame(meter);
    };
    rafRef.current = requestAnimationFrame(meter);
  }, [supported, teardown]);

  const pause = React.useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state === "recording") {
      rec.pause();
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setState("paused");
    }
  }, []);

  const resume = React.useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state === "paused") {
      rec.resume();
      timerRef.current = setInterval(() => {
        setElapsed((s) => {
          elapsedRef.current = s + 1;
          return s + 1;
        });
      }, 1000);
      setState("recording");
    }
  }, []);

  const stop = React.useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      rec.stop();
    }
    recorderRef.current = null;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = React.useCallback(() => {
    teardown();
    recorderRef.current = null;
    chunksRef.current = [];
    elapsedRef.current = 0;
    setResult(null);
    setElapsed(0);
    setError(null);
    setHasTabAudio(false);
    setState("idle");
  }, [teardown]);

  return {
    state,
    elapsed,
    level,
    error,
    hasTabAudio,
    result,
    supported,
    start,
    pause,
    resume,
    stop,
    reset,
  };
}
