import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

import { useLiveTranscript } from "@/lib/use-live-transcript";

/**
 * Live text, against a stand-in for the browser's recogniser.
 *
 * jsdom has no `SpeechRecognition`, which is convenient: it means the fake
 * below *is* the contract this hook is written against, and the awkward parts
 * of that contract can be reproduced deliberately. Two of them matter.
 *
 * Chrome ends a session after a stretch of silence whatever `continuous`
 * claims, so `onend` has to restart it — without that, live text works for the
 * first minute of a meeting and then quietly stops, which is worse than not
 * offering it. And `start()` on a running recogniser throws, so the restart
 * cannot be unconditional.
 */
type Handler = ((e: unknown) => void) | null;

class FakeRecogniser {
  static instances: FakeRecogniser[] = [];

  continuous = false;
  interimResults = false;
  lang = "";
  running = false;
  startCalls = 0;

  onresult: Handler = null;
  onerror: Handler = null;
  onend: (() => void) | null = null;

  constructor() {
    FakeRecogniser.instances.push(this);
  }

  start() {
    if (this.running) throw new Error("InvalidStateError");
    this.running = true;
    this.startCalls += 1;
  }

  stop() {
    this.running = false;
    this.onend?.();
  }

  abort() {
    this.running = false;
  }

  /** What the browser does after a pause in the talking. */
  endItself() {
    this.running = false;
    this.onend?.();
  }

  say(text: string, isFinal: boolean) {
    this.onresult?.({
      resultIndex: 0,
      results: { length: 1, 0: { length: 1, isFinal, 0: { transcript: text } } },
    });
  }

  fail(error: string) {
    this.onerror?.({ error });
  }
}

function latest(): FakeRecogniser {
  return FakeRecogniser.instances[FakeRecogniser.instances.length - 1];
}

beforeEach(() => {
  FakeRecogniser.instances = [];
  window.localStorage.clear();
  (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRecogniser;
});

afterEach(() => {
  delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
});

function render(props: { active?: boolean; elapsed?: number; lang?: string | null } = {}) {
  return renderHook(
    ({ active, elapsed, lang }) => useLiveTranscript({ active, elapsed, lang }),
    {
      initialProps: {
        active: props.active ?? true,
        elapsed: props.elapsed ?? 0,
        lang: props.lang ?? null,
      },
    },
  );
}

describe("useLiveTranscript availability", () => {
  it("listens as soon as a recording is running", async () => {
    const { result } = render();

    await waitFor(() => expect(result.current.supported).toBe(true));
    // No switch: words that only appear once you have found a toggle are words
    // you did not see during the meeting they were for.
    await waitFor(() => expect(FakeRecogniser.instances).toHaveLength(1));
  });

  it("does nothing at all before a recording starts", async () => {
    const { result } = render({ active: false });

    await waitFor(() => expect(result.current.supported).toBe(true));
    expect(FakeRecogniser.instances).toHaveLength(0);
  });

  it("reports no support when the browser has none", async () => {
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;

    const { result } = render();

    await waitFor(() => expect(result.current.supported).toBe(false));
    expect(FakeRecogniser.instances).toHaveLength(0);
  });
});

describe("useLiveTranscript listening", () => {
  async function listening(props: Parameters<typeof render>[0] = {}) {
    const view = render(props);
    await waitFor(() => expect(FakeRecogniser.instances.length).toBeGreaterThan(0));
    return view;
  }

  it("asks for continuous results with the interim ones", async () => {
    await listening();

    expect(latest().continuous).toBe(true);
    // Without interim results nothing appears until a phrase is finished, which
    // for a slow speaker is several seconds of a screen that looks broken.
    expect(latest().interimResults).toBe(true);
  });

  it("uses the account's transcript language", async () => {
    await listening({ lang: "es" });

    expect(latest().lang).toBe("es");
  });

  it("keeps a finished phrase and clears the interim one", async () => {
    const { result } = await listening();

    act(() => latest().say("hello there", false));
    expect(result.current.interim).toBe("hello there");

    act(() => latest().say("hello there.", true));

    expect(result.current.phrases.map((p) => p.text)).toEqual(["hello there."]);
    expect(result.current.interim).toBe("");
  });

  it("stamps a phrase from when it began, not when it was understood", async () => {
    const view = await listening({ elapsed: 5 });

    act(() => latest().say("shall we", false));
    // Recognition lags speech by a second or two; the word was said at 0:05.
    view.rerender({ active: true, elapsed: 9, lang: null });
    act(() => latest().say("shall we start?", true));

    expect(view.result.current.phrases[0].at).toBe(5);
  });

  it("drops a phrase that turned out to be nothing", async () => {
    const { result } = await listening();

    act(() => latest().say("   ", true));

    expect(result.current.phrases).toHaveLength(0);
  });

  it("restarts itself when the browser gives up on the silence", async () => {
    await listening();
    const recogniser = latest();
    expect(recogniser.startCalls).toBe(1);

    act(() => recogniser.endItself());

    // Chrome does this after a pause in the talking. Not restarting is how live
    // text works for the first minute of a meeting and then stops.
    expect(recogniser.startCalls).toBe(2);
  });

  it("stops for good when the recording stops", async () => {
    const view = await listening();
    const recogniser = latest();

    view.rerender({ active: false, elapsed: 0, lang: null });
    act(() => recogniser.endItself());

    expect(recogniser.startCalls).toBe(1);
  });

  it("stops listening while paused", async () => {
    const view = await listening();

    view.rerender({ active: false, elapsed: 10, lang: null });

    // A recogniser still running through a pause would put words into the one
    // stretch the user deliberately kept out of the recording.
    expect(latest().running).toBe(false);
    expect(view.result.current.interim).toBe("");
  });

  it("treats silence as silence, not as a failure", async () => {
    const { result } = await listening();

    act(() => latest().fail("no-speech"));

    expect(result.current.error).toBeNull();
  });

  it("says so when it is refused, without implicating the recording", async () => {
    const { result } = await listening();

    act(() => latest().fail("not-allowed"));

    expect(result.current.error).toMatch(/microphone access/i);
  });

  it("makes clear a failure here is not a failure of the recording", async () => {
    const { result } = await listening();

    act(() => latest().fail("network"));

    // The audio is being captured by a different pipeline entirely. Somebody
    // who reads this as "the recording broke" will stop a working one.
    expect(result.current.error).toMatch(/recording is not affected/i);
  });

  it("throws the words away on clear", async () => {
    const { result } = await listening();
    act(() => latest().say("hello.", true));

    act(() => result.current.clear());

    expect(result.current.phrases).toHaveLength(0);
  });
});
