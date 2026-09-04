import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as React from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AudioPlayer, useAudioController } from "@/components/audio-player";
import type { TranscriptMoment, TranscriptSegment } from "@/lib/types";

/**
 * The custom transport.
 *
 * The time arithmetic is covered in `lib/playback.test.ts`; what is left here
 * is the wiring — does pressing a button ask the media element for the right
 * thing. That matters because the native controls were removed, so a control
 * that renders but does nothing is now the only control there is.
 *
 * The keyboard guard gets the most attention. This page has a transcript find
 * box and two chat inputs, and a space bar that pauses the recording instead of
 * typing a space is worse than having no shortcut at all.
 */
const SEGMENTS: TranscriptSegment[] = [
  { id: "s1", start: 0, end: 10, speaker: "Priya", text: "one" },
  { id: "s2", start: 10, end: 20, speaker: "Marcus", text: "two" },
  { id: "s3", start: 30, end: 40, speaker: "Priya", text: "three" },
];

function moment(over: Partial<TranscriptMoment> = {}): TranscriptMoment {
  return {
    id: "mom_1",
    meetingId: "mtg_1",
    kind: "HIGHLIGHT",
    ranges: [],
    quote: "words",
    body: "",
    speaker: "Priya",
    startSeconds: 12,
    endSeconds: 18,
    createdAt: "2026-08-15T09:00:00Z",
    updatedAt: "2026-08-15T09:00:00Z",
    ...over,
  };
}

function Harness(props: Partial<React.ComponentProps<typeof AudioPlayer>> = {}) {
  const controller = useAudioController();
  return (
    <AudioPlayer
      src="http://example.test/a.mp3"
      controller={controller}
      segments={SEGMENTS}
      {...props}
    />
  );
}

function media(): HTMLMediaElement {
  const el = document.querySelector("audio") as HTMLMediaElement | null;
  if (!el) throw new Error("no media element rendered");
  return el;
}

/** jsdom reports NaN duration; give it one the way loadedmetadata would. */
function withDuration(seconds: number) {
  const el = media();
  Object.defineProperty(el, "duration", { configurable: true, value: seconds });
  act(() => {
    el.dispatchEvent(new Event("durationchange"));
  });
  return el;
}

function setTime(seconds: number) {
  const el = media();
  el.currentTime = seconds;
  act(() => {
    el.dispatchEvent(new Event("timeupdate"));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AudioPlayer transport", () => {
  it("renders a real control set, not the browser's", () => {
    render(<Harness />);
    for (const label of [
      "Play",
      "Back 10 seconds",
      "Forward 10 seconds",
      "Next speaker",
      "Previous speaker",
      "Playback speed",
      "Volume",
      "Mute",
      "Skip silence",
      "Seek",
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    // The native strip is what we replaced; leaving it on would give two of
    // every control, disagreeing about state.
    expect(media()).not.toHaveAttribute("controls");
  });

  it("plays and pauses", async () => {
    render(<Harness />);

    await userEvent.click(screen.getByLabelText("Play"));
    expect(media().paused).toBe(false);

    await userEvent.click(screen.getByLabelText("Pause"));
    expect(media().paused).toBe(true);
  });

  it("nudges backward and forward by ten seconds", async () => {
    render(<Harness />);
    withDuration(120);
    setTime(30);

    await userEvent.click(screen.getByLabelText("Back 10 seconds"));
    expect(media().currentTime).toBe(20);

    await userEvent.click(screen.getByLabelText("Forward 10 seconds"));
    expect(media().currentTime).toBe(30);
  });

  it("never seeks before the start", async () => {
    render(<Harness />);
    withDuration(120);
    setTime(3);

    await userEvent.click(screen.getByLabelText("Back 10 seconds"));

    expect(media().currentTime).toBe(0);
  });

  it("jumps to the next speaker, not the next utterance", async () => {
    render(<Harness />);
    withDuration(120);
    setTime(2);

    await userEvent.click(screen.getByLabelText("Next speaker"));

    expect(media().currentTime).toBe(10);
  });

  it("restarts the current speaker before going further back", async () => {
    render(<Harness />);
    withDuration(120);
    setTime(15);

    await userEvent.click(screen.getByLabelText("Previous speaker"));

    expect(media().currentTime).toBe(10);
  });

  it("disables the speaker jumps with no transcript", () => {
    render(<Harness segments={[]} />);
    expect(screen.getByLabelText("Next speaker")).toBeDisabled();
    expect(screen.getByLabelText("Previous speaker")).toBeDisabled();
  });

  it("changes playback speed", async () => {
    render(<Harness />);

    await userEvent.click(screen.getByLabelText("Playback speed"));
    await userEvent.click(screen.getByRole("menuitem", { name: "1.5×" }));

    expect(media().playbackRate).toBe(1.5);
  });

  it("offers the full range of speeds", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByLabelText("Playback speed"));
    for (const label of ["0.5×", "0.75×", "1×", "1.25×", "1.5×", "1.75×", "2×"]) {
      expect(screen.getByRole("menuitem", { name: label })).toBeInTheDocument();
    }
  });

  it("mutes and unmutes", async () => {
    render(<Harness />);

    await userEvent.click(screen.getByLabelText("Mute"));
    expect(media().muted).toBe(true);

    await userEvent.click(screen.getByLabelText("Unmute"));
    expect(media().muted).toBe(false);
  });

  it("treats dragging the volume to zero as a mute", () => {
    render(<Harness />);
    const slider = screen.getByLabelText("Volume");

    act(() => {
      // fireEvent-style change, since a range input is not clickable in jsdom.
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(slider, "0");
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Leaving the element unmuted at volume 0 would be silent anyway; leaving
    // it *muted* when dragged back up is what makes the slider look broken.
    expect(media().muted).toBe(true);
  });

  it("shows the position and the duration", () => {
    render(<Harness />);
    withDuration(3511);
    setTime(1934);
    expect(screen.getByText("32:14 / 58:31")).toBeInTheDocument();
  });
});

describe("AudioPlayer highlights", () => {
  it("offers nothing to filter when nothing is marked", () => {
    render(<Harness moments={[]} />);
    // A toggle that can only ever produce silence is worse than an absent one.
    expect(screen.queryByLabelText("Play highlights only")).not.toBeInTheDocument();
  });

  it("offers the filter once something is marked", () => {
    render(<Harness moments={[moment()]} />);
    expect(screen.getByLabelText("Play highlights only")).toBeInTheDocument();
  });

  it("ignores bookmarks, which have no span to play", () => {
    render(<Harness moments={[moment({ kind: "BOOKMARK", startSeconds: 30, endSeconds: 30 })]} />);
    expect(screen.queryByLabelText("Play highlights only")).not.toBeInTheDocument();
  });

  it("stops skip-silence competing with the highlight filter", async () => {
    render(<Harness moments={[moment()]} />);

    await userEvent.click(screen.getByLabelText("Play highlights only"));

    // Both want to move the playhead; two of them fighting shows up as a
    // stutter, so the stricter one wins and the other is visibly off.
    expect(screen.getByLabelText("Skip silence")).toBeDisabled();
  });

  it("disables skip-silence with no transcript to read gaps from", () => {
    render(<Harness segments={[]} />);
    expect(screen.getByLabelText("Skip silence")).toBeDisabled();
  });
});

describe("AudioPlayer keyboard", () => {
  it("plays and pauses on space", async () => {
    render(<Harness />);

    await userEvent.keyboard(" ");

    expect(media().paused).toBe(false);
  });

  it("seeks five seconds with the arrow keys", async () => {
    render(<Harness />);
    withDuration(120);
    setTime(30);

    await userEvent.keyboard("{ArrowRight}");
    expect(media().currentTime).toBe(35);

    await userEvent.keyboard("{ArrowLeft}");
    expect(media().currentTime).toBe(30);
  });

  it("stays out of the way while typing", async () => {
    render(
      <>
        <input aria-label="Find in transcript" />
        <Harness />
      </>,
    );
    const box = screen.getByLabelText("Find in transcript");

    await userEvent.click(box);
    await userEvent.type(box, "a b");

    // The space belongs in the search box, not to the transport.
    expect(media().paused).toBe(true);
    expect(box).toHaveValue("a b");
  });

  it("leaves browser shortcuts alone", async () => {
    render(<Harness />);

    await userEvent.keyboard("{Control>}l{/Control}");

    // Ctrl+L is the address bar. Swallowing modified keys would break the
    // browser to save a keystroke.
    expect(media().paused).toBe(true);
  });
});

/**
 * How long the recording is.
 *
 * Every recording Reverie makes itself is WebM out of the browser's
 * MediaRecorder, which writes no duration into the file, so the element
 * reports Infinity for it. That put a scrubber at zero and an end time of
 * 00:00 on every recorded meeting in the app — the position counted up
 * perfectly beside a bar that never moved.
 */
describe("the duration", () => {
  it("uses what the element knows", () => {
    render(<Harness durationSeconds={903} />);
    withDuration(120);

    // An uploaded MP3 carries an exact duration. It beats the pipeline's
    // rounded seconds, so the element wins whenever it has a real answer.
    expect(screen.getByLabelText("Seek")).toHaveAttribute("aria-valuemax", "120");
    expect(screen.getByText("00:00 / 02:00")).toBeInTheDocument();
  });

  it("falls back to what the server measured when the element has no idea", () => {
    render(<Harness durationSeconds={903} />);
    withDuration(Number.POSITIVE_INFINITY);

    expect(screen.getByLabelText("Seek")).toHaveAttribute("aria-valuemax", "903");
    expect(screen.getByText("00:00 / 15:03")).toBeInTheDocument();
  });

  it("moves the scrubber through a recording the element cannot measure", () => {
    render(<Harness durationSeconds={903} />);
    withDuration(Number.POSITIVE_INFINITY);
    setTime(259);

    // The bug, in one assertion: this read "04:19 of 00:00" and the bar behind
    // it stayed at zero for the length of the recording.
    expect(screen.getByLabelText("Seek")).toHaveAttribute("aria-valuetext", "04:19 of 15:03");
  });

  it("still says nothing rather than guessing when neither knows", () => {
    render(<Harness />);
    withDuration(Number.POSITIVE_INFINITY);

    // Meetings recorded before the pipeline stored a duration. An invented
    // length would put the playhead in the wrong place on every seek.
    expect(screen.getByText("00:00 / 00:00")).toBeInTheDocument();
  });

  it("seeks against the duration it settled on", () => {
    render(<Harness durationSeconds={903} />);
    withDuration(Number.POSITIVE_INFINITY);

    // jsdom lays nothing out, so the scrubber has no width of its own and the
    // click handler correctly refuses to divide by it.
    const seek = screen.getByLabelText("Seek");
    seek.getBoundingClientRect = () =>
      ({ left: 0, width: 200, top: 0, height: 8, right: 200, bottom: 8, x: 0, y: 0 }) as DOMRect;

    fireEvent.click(seek, { clientX: 100 });

    // Halfway along a fifteen-minute recording. Clicking a scrubber divides by
    // the duration, so with none the whole bar seeked to zero — the one place
    // it was already at.
    expect(media().currentTime).toBeCloseTo(451.5, 1);
  });
});


/**
 * The clock, and why it is not published on every frame.
 *
 * This value goes down into the transcript, so each publish re-renders several
 * hundred segments. At sixty a second React always had urgent work outstanding,
 * and an urgent update outranks a transition — which is what a route change is.
 * Clicking Home while audio played did nothing at all until you pressed pause,
 * at which point the app went straight to the page you had asked for minutes
 * earlier.
 *
 * The other half of the fix — publishing inside `startTransition`, so the
 * playhead shares a lane with the navigation instead of sitting above it — is
 * not observable from jsdom, which has no scheduler to starve. What is pinned
 * here is the rate.
 */
describe("the playhead's cost", () => {
  function Probe() {
    const controller = useAudioController();
    return (
      <audio
        ref={controller.ref as React.MutableRefObject<HTMLAudioElement | null>}
        src="http://example.test/a.webm"
      />
    );
  }

  /**
   * Drives the animation loop by hand, a frame at a time.
   *
   * Fake timers are no use for this. They do not control the MessageChannel
   * React runs transition work through, so every deferred publish coalesces
   * into a single commit at the end of the test — which is the scheduler
   * behaving exactly as intended, and which makes render counts useless as a
   * measure. Stubbing the frame callback instead gives the loop an explicit
   * clock, which is the input the throttle actually reads.
   */
  function frames() {
    let next: FrameRequestCallback | null = null;
    // One clock for the whole test, not one per call. A timestamp that starts
    // over would look to the throttle like time running backwards.
    let now = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      next = cb;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      next = null;
    });
    return function advance(count: number, msPerFrame = 16) {
      for (let i = 0; i < count; i += 1) {
        const cb = next;
        if (!cb) return;
        now += msPerFrame;
        act(() => cb(now));
      }
    };
  }

  /** Counts how often the loop samples the element's clock. */
  function countSamples(el: HTMLMediaElement): () => number {
    let reads = 0;
    let time = 0;
    Object.defineProperty(el, "currentTime", {
      configurable: true,
      get() {
        reads += 1;
        return time;
      },
      set(v: number) {
        time = v;
      },
    });
    return () => reads;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("samples about ten times a second while playing, not sixty", () => {
    const advance = frames();
    render(<Probe />);
    const el = media();
    act(() => {
      void el.play();
    });
    const reads = countSamples(el);

    advance(60);

    // Ten-ish, and the range matters in both directions: too many is the bug
    // this fixes, too few is a playhead that has stopped following the audio.
    // Sixty — one per frame — is what it used to be.
    expect(reads()).toBeGreaterThanOrEqual(8);
    expect(reads()).toBeLessThanOrEqual(12);
  });

  it("stops sampling entirely once paused", () => {
    const advance = frames();
    render(<Probe />);
    const el = media();
    act(() => {
      void el.play();
    });
    advance(30);
    act(() => {
      el.pause();
    });
    const reads = countSamples(el);

    advance(120);

    // The loop keeps running — it has to notice playback starting again — but
    // a paused element must not re-render the transcript at all. This is the
    // state the app spends most of its time in.
    expect(reads()).toBe(0);
  });

  it("keeps following the audio after it is resumed", () => {
    const advance = frames();
    render(<Probe />);
    const el = media();
    act(() => {
      void el.play();
    });
    advance(30);
    act(() => {
      el.pause();
    });
    advance(30);
    act(() => {
      void el.play();
    });
    const reads = countSamples(el);

    advance(60);

    // The throttle must not have latched on the last frame before the pause,
    // which would leave the playhead frozen for as long as the gap was.
    expect(reads()).toBeGreaterThanOrEqual(8);
  });
});

/**
 * A presigned link that stopped working.
 *
 * `src` is signed and lasts fifteen minutes. A meeting page is routinely open
 * for longer than that, and nothing refreshed it — so the recording played from
 * whatever was already buffered and died the moment it needed more bytes.
 *
 * The two symptoms are the same failure seen from two angles. Pause, wait, press
 * play: needs bytes. Click a word further along: needs bytes. Both were silent,
 * because the element had no error listener and both `play()` calls threw their
 * rejection away.
 */
describe("recovering a media source that expired", () => {
  function Recoverable({ onSourceExpired }: { onSourceExpired: () => void }) {
    const [src, setSrc] = React.useState("http://example.test/a.mp3?sig=old");
    const controller = useAudioController();
    return (
      <>
        <button onClick={() => setSrc("http://example.test/a.mp3?sig=fresh")}>
          refresh
        </button>
        <AudioPlayer
          src={src}
          controller={controller}
          segments={SEGMENTS}
          onSourceExpired={onSourceExpired}
        />
      </>
    );
  }

  function fail(el: HTMLMediaElement) {
    act(() => {
      el.dispatchEvent(new Event("error"));
    });
  }

  it("asks for a fresh link when the element reports an error", () => {
    const expired = vi.fn();
    render(<Recoverable onSourceExpired={expired} />);

    fail(media());

    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("asks once per link, so a dead recording cannot loop", () => {
    // Error, refetch, error, refetch is a network loop that reads as a hang and
    // is worse than the silence it replaced.
    const expired = vi.fn();
    render(<Recoverable onSourceExpired={expired} />);

    fail(media());
    fail(media());
    fail(media());

    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("puts the listener back where they were, still playing", async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementation(function (this: HTMLMediaElement) {
        Object.defineProperty(this, "paused", { configurable: true, value: false });
        return Promise.resolve();
      });
    try {
      const user = userEvent.setup();
      render(<Recoverable onSourceExpired={() => {}} />);
      const el = withDuration(600);
      act(() => {
        void el.play();
      });
      setTime(431);

      fail(el);
      play.mockClear();
      await user.click(screen.getByText("refresh"));

      // jsdom never fires `loadedmetadata`, and readyState is 0, so the restore
      // is queued exactly as it would be against a real element still loading.
      act(() => {
        Object.defineProperty(el, "readyState", { configurable: true, value: 1 });
        el.dispatchEvent(new Event("loadedmetadata"));
      });

      expect(el.currentTime).toBe(431);
      expect(play).toHaveBeenCalled();
    } finally {
      play.mockRestore();
    }
  });

  it("does not resume something the listener had paused", async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    try {
      const user = userEvent.setup();
      render(<Recoverable onSourceExpired={() => {}} />);
      const el = withDuration(600);
      setTime(120);

      fail(el);
      play.mockClear();
      await user.click(screen.getByText("refresh"));
      act(() => {
        Object.defineProperty(el, "readyState", { configurable: true, value: 1 });
        el.dispatchEvent(new Event("loadedmetadata"));
      });

      expect(el.currentTime).toBe(120);
      expect(play).not.toHaveBeenCalled();
    } finally {
      play.mockRestore();
    }
  });

  it("says so when there is nobody to ask for a fresh link", () => {
    // The player is constructed without the callback in a few places. Silence
    // was the old behaviour and it is the thing being fixed.
    render(<Harness />);

    fail(media());

    expect(screen.getByRole("status")).toHaveTextContent(/could not be loaded/i);
  });

  it("clears the message once a fresh link works", async () => {
    const user = userEvent.setup();
    render(<Recoverable onSourceExpired={() => {}} />);
    const el = media();

    fail(el);
    fail(el);        // second failure, with recovery already asked for
    expect(screen.getByRole("status")).toBeInTheDocument();

    await user.click(screen.getByText("refresh"));
    act(() => {
      Object.defineProperty(el, "readyState", { configurable: true, value: 1 });
      el.dispatchEvent(new Event("loadedmetadata"));
    });

    expect(screen.queryByRole("status")).toBeNull();
  });
});
