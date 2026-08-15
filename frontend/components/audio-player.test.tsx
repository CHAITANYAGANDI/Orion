import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, act } from "@testing-library/react";
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
