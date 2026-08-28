/**
 * The live streaming session, as a state machine.
 *
 * The reconciliation this feeds is tested in lib/live-turns.test.ts as pure
 * functions. What is left here is the part that touches the outside world: the
 * token, the socket, the audio tap, and the four transitions that go wrong —
 * start, pause, stop, and a socket that drops mid-meeting.
 *
 * Written against a fake WebSocket rather than a real one because the
 * interesting assertions are about what is *not* done: no second microphone, no
 * audio sent while paused, no API key anywhere near this file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useLiveTranscript, type LiveAudioSource } from "@/lib/use-live-transcript";

/* --------------------------- the fake socket ------------------------------ */

class FakeSocket {
  static open: FakeSocket[] = [];
  static readonly OPEN = 1;

  url: string;
  readyState = 0;
  binaryType = "";
  sent: (string | ArrayBuffer)[] = [];
  closed = false;

  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.open.push(this);
  }

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }

  /* -- test drivers -- */
  accept() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  deliver(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

/* ------------------------- the fake audio tap ----------------------------- */

function aSource() {
  const posted: unknown[] = [];
  const node = {
    port: {
      onmessage: null as ((e: MessageEvent) => void) | null,
      postMessage: (m: unknown) => posted.push(m),
    },
    disconnect: vi.fn(),
  };
  const created = vi.fn(async () => node as unknown as AudioWorkletNode);
  return { source: { createPcmNode: created } as LiveAudioSource, node, posted, created };
}

vi.mock("@/lib/auth-store", () => ({
  buildAuthHeaders: async () => ({ "X-Dev-User": "usr_dev" }),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  FakeSocket.open = [];
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ token: "tmp-token", expiresInSeconds: 45 }),
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function render(overrides: Partial<Parameters<typeof useLiveTranscript>[0]> = {}) {
  const tap = aSource();
  const props = {
    active: true,
    paused: false,
    source: tap.source,
    elapsed: 0,
    ...overrides,
  };
  const view = renderHook((p: typeof props) => useLiveTranscript(p), {
    initialProps: props,
  });
  return { ...view, tap };
}

/* -------------------------------------------------------------------------- */

describe("starting", () => {
  it("does nothing at all before a recording starts", async () => {
    render({ active: false });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeSocket.open).toHaveLength(0);
  });

  it("mints a token from Orion and never carries a provider key", async () => {
    render();

    await waitFor(() => expect(FakeSocket.open).toHaveLength(1));

    // The key stays in the ai-service. What reaches the browser expires in
    // under a minute and opens exactly one session.
    //
    // Absolute, and this assertion is the regression: a relative
    // `/api/v1/streaming/token` went to the Next.js server on port 3000
    // instead of the API on 8080 — there is no rewrite proxy — so live text
    // never started and reported only that it was unavailable.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8080/api/v1/streaming/token");
    expect(init).toMatchObject({ method: "POST" });
    // And authenticated, like every other call in the app. Without this the
    // request arrives as an anonymous one and is refused.
    expect(init.headers).toMatchObject({ "X-Dev-User": "usr_dev" });
    expect(FakeSocket.open[0].url).toContain("token=tmp-token");
  });

  it("asks for diarization and formatted turns", async () => {
    render();
    await waitFor(() => expect(FakeSocket.open).toHaveLength(1));

    const url = FakeSocket.open[0].url;
    // Diarization is the whole reason the browser preview was replaced.
    expect(url).toContain("speaker_labels=true");
    expect(url).toContain("format_turns=true");
    // The rate the worklet resamples to. A mismatch here is transcribed
    // rubbish rather than an error.
    expect(url).toContain("sample_rate=16000");
    expect(url).toContain("encoding=pcm_s16le");
  });

  it("pins no model name, so a retired one cannot take the feature down", async () => {
    render();
    await waitFor(() => expect(FakeSocket.open).toHaveLength(1));

    expect(FakeSocket.open[0].url).not.toContain("speech_model=");
  });

  it("taps the recorder's audio instead of opening a second microphone", async () => {
    const { tap } = render();
    await waitFor(() => expect(FakeSocket.open).toHaveLength(1));
    act(() => FakeSocket.open[0].accept());

    // The bug this closes: the browser speech API opened its own getUserMedia
    // and honoured the system default, so the live text could be listening to
    // the laptop lid while the recording was on a headset.
    await waitFor(() => expect(tap.created).toHaveBeenCalled());
  });
});

describe("words arriving", () => {
  it("shows one evolving turn, not a line per revision", async () => {
    const { result } = render();
    await waitFor(() => expect(FakeSocket.open).toHaveLength(1));
    act(() => FakeSocket.open[0].accept());

    act(() => {
      FakeSocket.open[0].deliver({ type: "Turn", turn_order: 1, transcript: "We need to" });
    });
    act(() => {
      FakeSocket.open[0].deliver({ type: "Turn", turn_order: 1, transcript: "We need to deploy" });
    });

    expect(result.current.turns).toHaveLength(0);
    expect(result.current.pending?.text).toBe("We need to deploy");

    act(() => {
      FakeSocket.open[0].deliver({
        type: "Turn", turn_order: 1, transcript: "We need to deploy.", end_of_turn: true,
      });
    });

    expect(result.current.turns.map((t) => t.text)).toEqual(["We need to deploy."]);
    expect(result.current.pending).toBeNull();
  });

  it("numbers the first voice heard as Speaker 1, whatever letter it got", async () => {
    const { result } = render();
    await waitFor(() => expect(FakeSocket.open).toHaveLength(1));
    act(() => FakeSocket.open[0].accept());
    act(() => {
      FakeSocket.open[0].deliver({
        type: "Turn", turn_order: 1, transcript: "Morning.", end_of_turn: true,
        speaker_label: "B", audio_start: 20000,
      });
    });

    // Changed deliberately: this asserted "Speaker 2", because the letter was
    // decoded by its position in the alphabet. That is the reported bug -- a
    // meeting whose voices clustered as A and D displayed Speaker 1 and
    // Speaker 4, with nobody in between. The provider's letters identify
    // clusters, not people, and the raw one is kept for diagnosing exactly
    // this.
    expect(result.current.turns[0]).toMatchObject({
      speaker: "Speaker 1", speakerRaw: "B", at: 20,
    });
  });

  it("splits one turn when its words say two people spoke", async () => {
    const { result } = render();
    await waitFor(() => expect(FakeSocket.open).toHaveLength(1));
    act(() => FakeSocket.open[0].accept());
    act(() => {
      FakeSocket.open[0].deliver({
        type: "Turn", turn_order: 1, end_of_turn: true, speaker_label: "A",
        transcript: "We should ship Friday. Exactly.",
        words: [
          { text: "We", start: 0, speaker: "A" },
          { text: "should", start: 400, speaker: "A" },
          { text: "ship", start: 800, speaker: "A" },
          { text: "Friday.", start: 1200, speaker: "A" },
          { text: "Exactly.", start: 1600, speaker: "B" },
        ],
      });
    });

    expect(result.current.turns.map((t) => [t.speaker, t.text])).toEqual([
      ["Speaker 1", "We should ship Friday."],
      ["Speaker 2", "Exactly."],
    ]);
  });

  it("applies a speaker correction to a turn already on screen", async () => {
    const { result } = render();
    await waitFor(() => expect(FakeSocket.open).toHaveLength(1));
    act(() => FakeSocket.open[0].accept());
    act(() => {
      FakeSocket.open[0].deliver({
        type: "Turn", turn_order: 3, transcript: "Exactly.", end_of_turn: true,
        speaker_label: "PENDING", audio_start: 18000,
      });
    });
    // The provider's placeholder while clustering catches up. It is not a name.
    expect(result.current.turns[0].speaker).toBe("Unknown speaker");

    act(() => {
      FakeSocket.open[0].deliver({
        type: "SpeakerRevision",
        revisions: [{ turn_order: 3, speaker_label: "B" }],
      });
    });

    // Reaching the transcript at all is the fix: the hook read `turns` from
    // this message and the provider sends `revisions`, so every correction was
    // dropped and the turn stayed unattributed for the rest of the meeting.
    expect(result.current.turns[0]).toMatchObject({
      speaker: "Speaker 1", speakerStatus: "attributed",
    });
  });

  it("ignores a message that is not JSON", async () => {
    const { result } = render();
    await waitFor(() => expect(FakeSocket.open).toHaveLength(1));
    act(() => FakeSocket.open[0].accept());
    act(() => FakeSocket.open[0].onmessage?.({ data: "<not json>" }));

    expect(result.current.turns).toHaveLength(0);
  });
});

describe("pause", () => {
  it("mutes the audio rather than closing the session", async () => {
    const { rerender, tap } = render();
    await waitFor(() => expect(FakeSocket.open).toHaveLength(1));
    act(() => FakeSocket.open[0].accept());
    await waitFor(() => expect(tap.created).toHaveBeenCalled());

    act(() => {
      rerender({ active: true, paused: true, source: tap.source, elapsed: 10 });
    });

    // Muted, not disconnected: the session carries a speaker model built up
    // over the meeting so far, and a pause should not throw it away.
    expect(tap.posted).toContainEqual({ muted: true });
    expect(FakeSocket.open[0].closed).toBe(false);
  });
});

describe("stopping", () => {
  it("asks the provider to flush the last turn before closing", async () => {
    const { unmount } = render();
    await waitFor(() => expect(FakeSocket.open).toHaveLength(1));
    act(() => FakeSocket.open[0].accept());

    unmount();

    // A bare close loses the turn in flight, which is the sentence somebody
    // was in the middle of when they pressed Stop.
    expect(FakeSocket.open[0].sent).toContainEqual(JSON.stringify({ type: "Terminate" }));
    expect(FakeSocket.open[0].closed).toBe(true);
  });

  it("closes the session when the recording ends", async () => {
    const { rerender, tap } = render();
    await waitFor(() => expect(FakeSocket.open).toHaveLength(1));
    act(() => FakeSocket.open[0].accept());

    act(() => {
      rerender({ active: false, paused: false, source: tap.source, elapsed: 30 });
    });

    expect(FakeSocket.open[0].closed).toBe(true);
  });
});

describe("when it cannot work", () => {
  it("says so once and stops, rather than retrying a refusal forever", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const { result } = render();

    await waitFor(() => expect(result.current.status).toBe("unavailable"));

    expect(result.current.supported).toBe(false);
    expect(FakeSocket.open).toHaveLength(0);
    // The one thing the user needs to know, which is that this is not about
    // their recording.
    expect(result.current.error).toMatch(/recording is not affected/i);
  });

  it("counts a dropped socket as a reconnect and keeps the words already on screen", async () => {
    const { result } = render();
    await waitFor(() => expect(FakeSocket.open).toHaveLength(1));
    act(() => FakeSocket.open[0].accept());
    act(() => {
      FakeSocket.open[0].deliver({
        type: "Turn", turn_order: 1, transcript: "Before the drop.", end_of_turn: true,
      });
    });

    act(() => FakeSocket.open[0].drop());

    await waitFor(() => expect(result.current.reconnects).toBe(1));
    expect(result.current.status).toBe("reconnecting");
    // Losing an hour of transcript because a wifi hiccup closed a socket would
    // be the failure this whole path exists to avoid.
    expect(result.current.turns.map((t) => t.text)).toEqual(["Before the drop."]);
  });
});
