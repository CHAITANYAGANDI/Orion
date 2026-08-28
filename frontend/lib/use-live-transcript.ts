"use client";

/**
 * Words on screen while somebody is still saying them.
 *
 * This is **not** the transcript. Orion's canonical transcript is made after
 * Stop, from the uploaded file, with the whole recording in view — see
 * `ai-service/app/providers/assemblyai_adapter.py`. What this produces is
 * provisional and is replaced wholesale when that finishes. The two optimise
 * different things on purpose: this one buys latency at the cost of context,
 * and the other has the entire meeting to look at, so it wins.
 *
 * ## What this used to be, and why it is not that any more
 *
 * `window.SpeechRecognition`. It was a preview of a preview:
 *
 *  - **It opened its own microphone.** A separate `getUserMedia` call, honouring
 *    the browser's default input and not the device chosen in the control bar.
 *    So the live text could be listening to the laptop lid while the recording
 *    was on the headset — and the resulting comparison ("Orion heard this,
 *    Otter heard that") was between two different audio signals.
 *  - **It had no speaker concept at all.** Every line under one avatar, where a
 *    mature product shows the speaker change.
 *  - **Its timestamps were invented here.** Orion's own `elapsed` counter,
 *    sampled when recognition happened to return. A line spoken at 0:04 and
 *    recognised six seconds later was labelled 0:10.
 *  - **Firefox has none of it**, and the audio went to Google or Apple.
 *
 * Now: AssemblyAI Universal-Streaming, over a websocket, fed from **the same
 * `MediaStream` the recorder is recording**, with provider diarization and
 * provider timestamps.
 *
 * ## The key never reaches this file
 *
 * The browser holds a token minted by Spring, valid for well under a minute and
 * good for exactly one streaming session. `ASSEMBLYAI_API_KEY` stays in the
 * ai-service. See `backend-spring/.../StreamingTokenController.java`.
 *
 * ## Pause means paused
 *
 * The recorder excludes paused audio from the file. Streaming through a pause
 * would put words into the transcript for the exact stretch somebody stopped it
 * from being recorded — so the worklet is muted rather than the socket closed,
 * which keeps the session (and its speaker model) alive across a short pause.
 */

import * as React from "react";
import { API_BASE } from "@/lib/api";
import { buildAuthHeaders } from "@/lib/auth-store";
import { CanonicalSpeakers } from "@/lib/canonical-speakers";
import {
  applySpeakerRevision,
  applyTurn,
  finalTurns,
  pendingTurn,
  type LiveTurn,
  type SessionContext,
} from "@/lib/live-turns";

export type { LiveTurn } from "@/lib/live-turns";

/** Where the live session stands, for the one line of status the UI shows. */
export type LiveStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "reconnecting"
  | "unavailable";

export interface UseLiveTranscript {
  /**
   * False only where live transcription cannot work at all.
   *
   * Unlike the browser API this replaced, that is not a per-browser question —
   * websockets and AudioWorklet are everywhere — so this is about whether the
   * deployment has AssemblyAI configured.
   */
  supported: boolean;
  status: LiveStatus;
  /** Settled turns, in the order they were spoken. */
  turns: LiveTurn[];
  /** The turn still being spoken, which will change before it settles. */
  pending: LiveTurn | null;
  error: string | null;
  /** How many times the socket has had to be reopened. Telemetry, not UI. */
  reconnects: number;
  clear: () => void;
}

const WS_URL = "wss://streaming.assemblyai.com/v3/ws";

/**
 * Query parameters, verified against the live service.
 *
 * `speaker_labels` is the one that matters and the one the published docs
 * disagreed with themselves about; the session's `Begin` message echoes the
 * configuration back, and it confirms diarization is on. `format_turns` is what
 * puts punctuation and casing on a finalised turn — without it the live text is
 * the unpunctuated stream people recognise as "a rough preview".
 *
 * `speech_model` is deliberately absent: the service's default is already
 * `universal-3-5-pro` and naming it pins the product to a string that will be
 * retired while nobody is looking.
 */
const SAMPLE_RATE = 16000;

/** Backoff between reconnection attempts, in milliseconds. */
const RETRY_DELAYS = [500, 1000, 2000, 4000, 8000];

export function useLiveTranscript({
  active,
  paused,
  /** The recorder's own mixing node. Not a second microphone. */
  source,
  elapsed,
}: {
  /** A recording exists and audio should be streaming. */
  active: boolean;
  /** Recording exists but is paused: hold the session, send nothing. */
  paused: boolean;
  source: LiveAudioSource | null;
  /** Seconds recorded so far, used only to place a reconnected session. */
  elapsed: number;
}): UseLiveTranscript {
  const [status, setStatus] = React.useState<LiveStatus>("idle");
  const [turns, setTurns] = React.useState<LiveTurn[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [reconnects, setReconnects] = React.useState(0);
  const [supported, setSupported] = React.useState(true);

  const socketRef = React.useRef<WebSocket | null>(null);
  const nodeRef = React.useRef<AudioWorkletNode | null>(null);
  const wantOpenRef = React.useRef(false);
  const attemptRef = React.useRef(0);
  const retryRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRef = React.useRef<SessionContext>({ epoch: 0, offsetSeconds: 0 });
  // Speaker numbering for this meeting, not for this socket. It deliberately
  // outlives a reconnect: the provider restarts its cluster letters from "A"
  // on a new session, and renumbering from there would rename everybody on
  // screen halfway through the meeting.
  const speakersRef = React.useRef(new CanonicalSpeakers());
  // Read inside handlers installed once; a value closed over would be the one
  // from the render that installed them.
  const elapsedRef = React.useRef(0);
  elapsedRef.current = elapsed;

  const clear = React.useCallback(() => {
    setTurns([]);
    setError(null);
    // A new recording is a new meeting: Speaker 1 has to be free again.
    speakersRef.current = new CanonicalSpeakers();
  }, []);

  /** Stop sending audio without giving up the session. */
  React.useEffect(() => {
    nodeRef.current?.port.postMessage({ muted: paused });
  }, [paused]);

  React.useEffect(() => {
    if (!active || !source) {
      teardown();
      setStatus("idle");
      return;
    }

    wantOpenRef.current = true;
    void connect();

    return () => {
      teardown();
    };

    /* ---------------------------------------------------------------- */

    async function connect(): Promise<void> {
      if (!wantOpenRef.current || !source) return;
      setStatus(attemptRef.current === 0 ? "connecting" : "reconnecting");

      let token: string;
      try {
        token = await mintToken();
      } catch (err) {
        // A deployment with no AssemblyAI key answers this way, and there is
        // nothing to retry: say so once and stop rather than reconnecting in a
        // loop against a service that will keep refusing.
        setSupported(false);
        setStatus("unavailable");
        setError(
          "Live text isn't available. The recording is not affected and will still be transcribed.",
        );
        return;
      }

      // A new socket is a new session: the provider counts turns and
      // timestamps from zero again, so the epoch scopes the keys and the
      // offset puts this session's clock on the recording's timeline.
      sessionRef.current = {
        epoch: sessionRef.current.epoch + 1,
        offsetSeconds: elapsedRef.current,
      };

      const query = new URLSearchParams({
        token,
        sample_rate: String(SAMPLE_RATE),
        encoding: "pcm_s16le",
        format_turns: "true",
        speaker_labels: "true",
      });
      const socket = new WebSocket(`${WS_URL}?${query.toString()}`);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;

      socket.onopen = () => {
        attemptRef.current = 0;
        setStatus("listening");
        setError(null);
        void attachWorklet(socket);
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        const session = sessionRef.current;
        const speakers = speakersRef.current;
        if (message.type === "Turn") {
          setTurns((prev) => applyTurn(prev, message, session, speakers));
        } else if (message.type === "SpeakerRevision") {
          // Not optional politeness from the provider: a turn it has not yet
          // clustered arrives labelled PENDING, and this is the message that
          // eventually says who it was.
          setTurns((prev) => applySpeakerRevision(prev, message, session, speakers));
        } else if (message.type === "Error") {
          // Carried as a status, not as an exception: the recording is fine
          // and the user does not need to act.
          setError(liveTextFailed());
        }
      };

      socket.onclose = () => {
        detachWorklet();
        if (!wantOpenRef.current) return;
        scheduleRetry();
      };

      socket.onerror = () => {
        // `onclose` always follows, and it is the one that retries.
        setError(liveTextFailed());
      };
    }

    function scheduleRetry(): void {
      const delay = RETRY_DELAYS[Math.min(attemptRef.current, RETRY_DELAYS.length - 1)];
      attemptRef.current += 1;
      setReconnects((n) => n + 1);
      setStatus("reconnecting");
      retryRef.current = setTimeout(() => void connect(), delay);
    }

    async function attachWorklet(socket: WebSocket): Promise<void> {
      if (!source) return;
      try {
        const node = await source.createPcmNode();
        node.port.onmessage = (event: MessageEvent) => {
          if (socket.readyState !== WebSocket.OPEN) return;
          socket.send(event.data as ArrayBuffer);
        };
        node.port.postMessage({ muted: paused });
        nodeRef.current = node;
      } catch {
        setError(liveTextFailed());
      }
    }

    function detachWorklet(): void {
      const node = nodeRef.current;
      if (!node) return;
      node.port.onmessage = null;
      try {
        node.disconnect();
      } catch {
        /* Context already closed. */
      }
      nodeRef.current = null;
    }

    function teardown(): void {
      wantOpenRef.current = false;
      if (retryRef.current) {
        clearTimeout(retryRef.current);
        retryRef.current = null;
      }
      detachWorklet();
      const socket = socketRef.current;
      socketRef.current = null;
      if (!socket) return;
      // `Terminate` rather than a bare close: it asks the provider to flush the
      // last turn, which is otherwise lost — and the last turn is the sentence
      // somebody was in the middle of when they pressed Stop.
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "Terminate" }));
        }
      } catch {
        /* Already gone. */
      }
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      try {
        socket.close();
      } catch {
        /* Already gone. */
      }
    }
    // `paused` is handled by its own effect so a pause does not tear the
    // session down and lose the speaker model built up so far.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, source]);

  return {
    supported,
    status,
    turns: finalTurns(turns),
    pending: pendingTurn(turns),
    error,
    reconnects,
    clear,
  };
}

function liveTextFailed(): string {
  return "Live text stopped. The recording is not affected.";
}

/**
 * What the hook needs from the recorder: a PCM tap, and no microphone of its own.
 *
 * An interface rather than the `AudioContext` itself so that the recorder stays
 * the only thing that owns a microphone. The one bug class this removes is the
 * one that made the old preview untrustworthy — live text listening to a
 * different input from the recording.
 */
export interface LiveAudioSource {
  createPcmNode: () => Promise<AudioWorkletNode>;
}

/**
 * Ask Orion for a streaming credential.
 *
 * <p>Absolute, and authenticated. A relative `/api/v1/...` was wrong twice
 * over: the API is on a different origin from the app — port 8080 against the
 * app's 3000, with no rewrite proxy — so the request went to Next.js and
 * 404ed; and it carried none of the auth headers every other call in the app
 * gets from `prepareHeaders`, so it would have been rejected even if it had
 * arrived. Live text simply never started, and said only that it was
 * unavailable.
 *
 * <p>Written by hand rather than as an RTK Query endpoint because the caller
 * is not a component: this is invoked from inside a websocket lifecycle, once
 * per connection, and a cached mutation hook would be a token reused past its
 * expiry.
 */
async function mintToken(): Promise<string> {
  const response = await fetch(`${API_BASE}/api/v1/streaming/token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(await buildAuthHeaders()),
    },
    credentials: "include",
  });
  if (!response.ok) throw new Error(`token ${response.status}`);
  const body = (await response.json()) as { token?: string };
  if (!body.token) throw new Error("token missing");
  return body.token;
}
