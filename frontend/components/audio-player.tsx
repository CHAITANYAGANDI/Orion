"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";

export interface AudioController {
  // Typed as the shared media interface, not HTMLAudioElement: the same
  // controller drives a <video> element for video uploads, and everything it
  // touches (currentTime, play, paused) lives on HTMLMediaElement.
  ref: React.MutableRefObject<HTMLMediaElement | null>;
  currentTime: number;
  setCurrentTime: (t: number) => void;
  seekTo: (seconds: number) => void;
}

/** Shared media state so the transcript + chat citations can drive playback. */
export function useAudioController(): AudioController {
  const ref = React.useRef<HTMLMediaElement | null>(null);
  const [currentTime, setCurrentTime] = React.useState(0);

  // `timeupdate` fires roughly four times a second, which is fine for marking
  // which paragraph is playing but far too coarse to follow words: at normal
  // speaking pace several words pass between events, so the highlight jumps
  // in clumps. While playing, the clock is read every animation frame instead;
  // `timeupdate` still covers seeking and pausing, when no frames are running.
  React.useEffect(() => {
    let frame = 0;

    const tick = () => {
      const el = ref.current;
      if (el && !el.paused && !el.ended) {
        setCurrentTime(el.currentTime);
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const seekTo = React.useCallback((seconds: number) => {
    const el = ref.current;
    if (!el) return;
    el.currentTime = Math.max(0, seconds);
    setCurrentTime(el.currentTime);
    void el.play().catch(() => {
      /* autoplay may be blocked; user can press play */
    });
  }, []);

  return { ref, currentTime, setCurrentTime, seekTo };
}

/**
 * Native media element wired to a shared controller. Clicking a transcript line
 * or a chat citation calls `controller.seekTo()`; `onTimeUpdate` feeds the
 * active-segment highlight.
 *
 * <p>Renders a `<video>` when the meeting is one — a video played through an
 * `<audio>` element gives sound and no picture, which for a screen-share
 * recording throws away the half that mattered. Everything else about playback
 * is identical, which is why one controller serves both.
 */
export function AudioPlayer({
  src,
  controller,
  contentType,
}: {
  src: string;
  controller: AudioController;
  /** MIME type of the stored media. Absent (older meetings) means audio. */
  contentType?: string | null;
}) {
  const isVideo = !!contentType && contentType.startsWith("video/");

  const shared = {
    src,
    controls: true,
    preload: "metadata" as const,
    onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) =>
      controller.setCurrentTime(e.currentTarget.currentTime),
  };

  return (
    <Card>
      <CardContent className="py-3">
        {isVideo ? (
          <video
            ref={controller.ref as React.MutableRefObject<HTMLVideoElement | null>}
            playsInline
            {...shared}
            // Tall portrait clips would otherwise push the transcript off screen.
            className="max-h-[60vh] w-full rounded-md bg-black"
          />
        ) : (
          <audio
            ref={controller.ref as React.MutableRefObject<HTMLAudioElement | null>}
            {...shared}
            className="w-full"
          />
        )}
      </CardContent>
    </Card>
  );
}
