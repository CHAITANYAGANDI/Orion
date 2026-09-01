"use client";

/**
 * In-browser meeting capture: the microphone, and nothing else.
 *
 * There was a second mode that also captured the audio of another tab, for
 * meetings happening in Meet, Zoom or Teams. It is gone. What made it untenable
 * was not the capture — that part worked in Chromium — but everything around
 * it: it existed only in Chrome and Edge, it required the person recording to
 * pick the right tab out of a screen-picker and find a checkbox inside it, and
 * the commonest outcome of getting either wrong was a recording of one half of
 * a conversation that looked exactly like a recording of all of it. A capture
 * mode whose failure is silent and whose success depends on a dialog the app
 * cannot see is not a mode, it is a coin toss.
 *
 * So one source, through a single `AudioContext` into one
 * `MediaStreamAudioDestinationNode`. The indirection earns its keep even with
 * one input: `MediaRecorder` is bound to the destination rather than to the
 * microphone, which is what lets the microphone be swapped mid-recording
 * without splitting the meeting into two files.
 */

import * as React from "react";
import type { LiveAudioSource } from "@/lib/use-live-transcript";

export type RecorderState = "idle" | "requesting" | "recording" | "paused" | "stopped";

export interface RecorderResult {
  file: File;
  durationSeconds: number;
}

/**
 * Microphone constraints, tuned for a room rather than for a headset.
 *
 * The browser defaults assume one person at a desk wearing one. In a room that
 * assumption actively removes meeting content: noise suppression is trained on
 * a near-field voice and treats the quieter person across the table as noise,
 * and echo cancellation attenuates whatever it decides is a room reflection —
 * which, with several people at varying distances, includes some of them. Auto
 * gain is the one that helps, lifting the far end of the table.
 *
 * Chosen for everybody now that the microphone is the whole recording. The two
 * failures are not symmetrical: the desk assumption deletes the second person
 * from the transcript, while the room assumption costs a solo speaker some
 * extra room tone that transcription handles perfectly well.
 */
function micConstraints(deviceId?: string | null): MediaTrackConstraints {
  const tuning: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: true,
  };
  // `exact`, not a preference. A soft constraint that quietly falls back to the
  // system default is how somebody records a laptop lid for an hour while the
  // picker on screen says "headset" — the failure is invisible until playback.
  return deviceId ? { ...tuning, deviceId: { exact: deviceId } } : tuning;
}

/**
 * Below this, nothing is arriving.
 *
 * `level` is an RMS of the mixed input scaled by 3, so ordinary room tone sits
 * well above this and a muted microphone or a hardware switch sits at zero.
 * Deliberately not zero itself: a live-but-silent input still carries a hair of
 * noise, and a threshold of 0 would call that "audio" and never warn anybody.
 */
export const SILENCE_LEVEL = 0.02;

export interface UseRecorder {
  state: RecorderState;
  /** Whole seconds of audio actually recorded (excludes paused time). */
  elapsed: number;
  /**
   * When this recording began, for the heading that says what the meeting is.
   * Wall-clock rather than derived from `elapsed`, which excludes paused time
   * and would slide the start of the meeting later every time somebody paused.
   */
  startedAt: Date | null;
  /** 0–1 input level, for the meter. */
  level: number;
  /**
   * How long the input has been silent, in whole seconds. Zero unless a
   * recording is running — a paused recorder is silent by definition and
   * warning about it would be reporting the user's own choice as a fault.
   */
  silentSeconds: number;
  error: string | null;
  result: RecorderResult | null;
  supported: boolean;
  /** Microphones this browser will admit to. Labels are blank until permission. */
  devices: MediaDeviceInfo[];
  /** The chosen microphone, or null for whatever the system considers default. */
  deviceId: string | null;
  /** Switches the live microphone if there is one, otherwise arms the next. */
  setDeviceId: (id: string | null) => void;
  /**
   * A PCM tap on the audio already being recorded, for live transcription.
   *
   * <p>Null until a recording is running. Exposed as a factory rather than as
   * the `AudioContext` so this hook stays the only thing in the app that owns
   * a microphone: the live transcript reads the stream being recorded, and
   * cannot end up listening to a different input. That was a real bug and not
   * a hypothetical one — the browser speech API this replaced opened its own
   * `getUserMedia` and honoured the system default, so the live text could be
   * on the laptop lid while the recording was on a headset.
   *
   * <p>Follows a microphone change mid-recording for the same reason the
   * `MediaRecorder` does: it is attached to the graph, not to a device.
   */
  liveSource: LiveAudioSource | null;
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
  const [startedAt, setStartedAt] = React.useState<Date | null>(null);
  const [level, setLevel] = React.useState(0);
  const [silentSeconds, setSilentSeconds] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [devices, setDevices] = React.useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceIdState] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<RecorderResult | null>(null);

  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const streamsRef = React.useRef<MediaStream[]>([]);
  const audioCtxRef = React.useRef<AudioContext | null>(null);
  const analyserRef = React.useRef<AnalyserNode | null>(null);
  // The mixing point and the node currently feeding it from the microphone.
  // Held so the microphone can be replaced mid-recording: MediaRecorder is
  // bound to the destination, not to any particular input.
  const destinationRef = React.useRef<MediaStreamAudioDestinationNode | null>(null);
  const micSourceRef = React.useRef<MediaStreamAudioSourceNode | null>(null);
  const micStreamRef = React.useRef<MediaStream | null>(null);
  // The live-transcription tap, when one has been asked for. Held so a
  // microphone swap can be reconnected to it.
  const pcmNodeRef = React.useRef<AudioWorkletNode | null>(null);
  const deviceIdRef = React.useRef<string | null>(null);
  // When the input first went quiet, or null while it is not. A timestamp
  // rather than a counter so the answer does not depend on the frame rate.
  const silenceSinceRef = React.useRef<number | null>(null);
  const rafRef = React.useRef<number | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
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
    destinationRef.current = null;
    micSourceRef.current = null;
    if (pcmNodeRef.current) {
      pcmNodeRef.current.port.onmessage = null;
      try {
        pcmNodeRef.current.disconnect();
      } catch {
        /* Context already closed. */
      }
      pcmNodeRef.current = null;
    }
    micStreamRef.current = null;
    silenceSinceRef.current = null;
    setSilentSeconds(0);
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {
        /* already closed */
      });
      audioCtxRef.current = null;
    }
    setLevel(0);
  }, []);

  React.useEffect(() => teardown, [teardown]);

  /**
   * Ask the browser which microphones exist.
   *
   * Worth calling twice. Before permission is granted a browser returns the
   * devices with **empty labels** — enough to know how many there are, not
   * enough to name one, so a picker built from that read "Microphone 1,
   * Microphone 2". Calling it again after `getUserMedia` succeeds is what turns
   * those into "Headset (Jabra)". Failure is silent: not being able to list
   * microphones is not a reason to be unable to record with one.
   */
  const refreshDevices = React.useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === "audioinput"));
    } catch {
      /* Enumeration blocked; the default microphone still works. */
    }
  }, []);

  // Plugging in a headset mid-meeting is the commonest reason this list changes,
  // and it is exactly when somebody reaches for the picker.
  React.useEffect(() => {
    void refreshDevices();
    const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!media?.addEventListener) return;
    const onChange = () => void refreshDevices();
    media.addEventListener("devicechange", onChange);
    return () => media.removeEventListener("devicechange", onChange);
  }, [refreshDevices]);

  /**
   * Drive the input meter from the analyser until stopped.
   *
   * Held outside `start` so pause can stop it and resume can start it again.
   * A meter that keeps twitching while paused reads as "still recording", which
   * is the one thing the paused state exists to deny — and it is the kind of
   * mistake that is only discovered after a meeting was not captured.
   */
  const runMeter = React.useCallback(() => {
    const tick = () => {
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
      const next = Math.min(1, Math.sqrt(sum / buffer.length) * 3);
      setLevel(next);

      // Whole seconds, so this settles to one value per second and React drops
      // the other ~59 renders a frame-by-frame counter would cause.
      if (next < SILENCE_LEVEL) {
        if (silenceSinceRef.current === null) silenceSinceRef.current = Date.now();
        setSilentSeconds(Math.floor((Date.now() - silenceSinceRef.current) / 1000));
      } else {
        silenceSinceRef.current = null;
        setSilentSeconds(0);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const stopMeter = React.useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setLevel(0);
    // Not silence — a stopped meter. Leaving the count running would put "no
    // audio is being captured" on screen the moment somebody pressed Pause.
    silenceSinceRef.current = null;
    setSilentSeconds(0);
  }, []);

  const start = React.useCallback(async () => {
    if (!supported) {
      setError("This browser can't record audio.");
      return;
    }

    setError(null);
    setResult(null);
    setElapsed(0);
    setStartedAt(new Date());
    setState("requesting");

    let micStream: MediaStream;

    // 1) The microphone. Without it there is nothing to record, so a denial
    //    here ends the attempt rather than degrading it.
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: micConstraints(deviceIdRef.current),
      });
    } catch {
      setState("idle");
      // A device that has been unplugged since it was picked fails `exact` and
      // lands here, which would otherwise read as a permission problem for
      // somebody who granted permission long ago. Forget it and let the next
      // attempt use the system default.
      if (deviceIdRef.current) {
        deviceIdRef.current = null;
        setDeviceIdState(null);
        setError("That microphone is no longer available. Choose another and start again.");
        return;
      }
      setError("Microphone access was denied. Reverie needs it to record you.");
      return;
    }

    // Now that permission exists, the browser will name the devices.
    void refreshDevices();

    streamsRef.current = [micStream];
    micStreamRef.current = micStream;

    // 2) Route it through the mixer.
    const AudioCtx: typeof AudioContext =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    audioCtxRef.current = ctx;
    const destination = ctx.createMediaStreamDestination();
    destinationRef.current = destination;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyserRef.current = analyser;

    const micSource = ctx.createMediaStreamSource(micStream);
    micSource.connect(destination);
    micSource.connect(analyser);
    micSourceRef.current = micSource;

    // 3) Record what comes out of it.
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
      setResult({ file, durationSeconds: elapsedRef.current });
      setState("stopped");
      teardown();
    };

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

    runMeter();
  }, [supported, teardown, runMeter, refreshDevices]);

  /**
   * Change microphone, without stopping.
   *
   * The recorder is attached to the mixing destination rather than to any
   * input, so unplugging one source node and plugging in another is something
   * `MediaRecorder` never sees: the file keeps growing across the swap, and the
   * only audible trace is the moment of the change itself. Doing this by
   * restarting instead would mean two files for one meeting.
   *
   * With nothing running it simply arms the next recording, which is why the
   * picker is usable before pressing Record.
   */
  const setDeviceId = React.useCallback((id: string | null) => {
    const next = id || null;
    deviceIdRef.current = next;
    setDeviceIdState(next);

    const ctx = audioCtxRef.current;
    const destination = destinationRef.current;
    const previousSource = micSourceRef.current;
    const previousStream = micStreamRef.current;
    if (!ctx || !destination || !previousSource || !previousStream) return;

    void (async () => {
      let replacement: MediaStream;
      try {
        replacement = await navigator.mediaDevices.getUserMedia({
          audio: micConstraints(next),
        });
      } catch {
        // The old microphone is still connected and still recording, so this is
        // a failed change rather than a broken recording — say so and stop.
        setError("Couldn't switch microphone. Still recording from the previous one.");
        return;
      }

      previousSource.disconnect();
      previousStream.getTracks().forEach((t) => t.stop());

      const source = ctx.createMediaStreamSource(replacement);
      source.connect(destination);
      if (analyserRef.current) source.connect(analyserRef.current);
      // And the live transcript, which is attached to the graph rather than to
      // a device. Without this, swapping microphone mid-meeting leaves the
      // recording running and the live text silently listening to nothing.
      if (pcmNodeRef.current) source.connect(pcmNodeRef.current);

      micSourceRef.current = source;
      micStreamRef.current = replacement;
      streamsRef.current = [
        replacement,
        ...streamsRef.current.filter((stream) => stream !== previousStream),
      ];
      setError(null);
    })();
  }, []);

  /**
   * Build the PCM tap, on the graph that is already being recorded.
   *
   * <p>Connected from the microphone source rather than from the recording
   * destination, because a `MediaStreamAudioDestinationNode` is a sink and
   * nothing downstream can read it. Same audio either way — it is the same node
   * feeding both.
   *
   * <p><b>The sample rate is checked, not assumed.</b> An `AudioContext` runs
   * at whatever the hardware likes; 44100 and 48000 are the usual answers and
   * 16000 is essentially never one of them. The worklet resamples to the rate
   * the provider is told about, and a mismatch there does not fail loudly — it
   * transcribes chipmunks, or nothing at all. If the browser reports a rate
   * that cannot be resampled from, this refuses rather than streaming rubbish.
   */
  const createPcmNode = React.useCallback(async (): Promise<AudioWorkletNode> => {
    const ctx = audioCtxRef.current;
    const micSource = micSourceRef.current;
    if (!ctx || !micSource) {
      throw new Error("No recording to tap for live transcription.");
    }
    if (!Number.isFinite(ctx.sampleRate) || ctx.sampleRate < 8000) {
      throw new Error(`Unusable audio sample rate: ${ctx.sampleRate}`);
    }
    if (!ctx.audioWorklet) {
      throw new Error("This browser has no AudioWorklet.");
    }

    // Idempotent per context; a second call resolves immediately.
    await ctx.audioWorklet.addModule("/pcm-worklet.js");
    const node = new AudioWorkletNode(ctx, "pcm-downsampler");
    micSource.connect(node);
    pcmNodeRef.current = node;
    return node;
  }, []);

  const liveSource = React.useMemo<LiveAudioSource | null>(
    // Only once there is a graph to tap. A factory handed out before then
    // would be one the live transcript could call and be refused by.
    () => (state === "recording" || state === "paused" ? { createPcmNode } : null),
    [state, createPcmNode],
  );

  const pause = React.useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state === "recording") {
      rec.pause();
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      // The clock and the meter both stop, so nothing on screen still moves.
      stopMeter();
      setState("paused");
    }
  }, [stopMeter]);

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
      runMeter();
      setState("recording");
    }
  }, [runMeter]);

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
    setStartedAt(null);
    setError(null);
    silenceSinceRef.current = null;
    setSilentSeconds(0);
    setState("idle");
  }, [teardown]);

  return {
    state,
    elapsed,
    startedAt,
    level,
    silentSeconds,
    error,
    result,
    supported,
    devices,
    deviceId,
    setDeviceId,
    liveSource,
    start,
    pause,
    resume,
    stop,
    reset,
  };
}
