"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";

export interface AudioController {
  ref: React.MutableRefObject<HTMLAudioElement | null>;
  currentTime: number;
  setCurrentTime: (t: number) => void;
  seekTo: (seconds: number) => void;
}

/** Shared audio state so the transcript + chat citations can drive playback. */
export function useAudioController(): AudioController {
  const ref = React.useRef<HTMLAudioElement | null>(null);
  const [currentTime, setCurrentTime] = React.useState(0);

  const seekTo = React.useCallback((seconds: number) => {
    const el = ref.current;
    if (!el) return;
    el.currentTime = Math.max(0, seconds);
    void el.play().catch(() => {
      /* autoplay may be blocked; user can press play */
    });
  }, []);

  return { ref, currentTime, setCurrentTime, seekTo };
}

/**
 * Native audio element wired to a shared controller. Clicking a transcript line
 * or a chat citation calls `controller.seekTo()`; `onTimeUpdate` feeds the
 * active-segment highlight.
 */
export function AudioPlayer({ src, controller }: { src: string; controller: AudioController }) {
  return (
    <Card>
      <CardContent className="py-3">
        <audio
          ref={controller.ref}
          src={src}
          controls
          preload="metadata"
          className="w-full"
          onTimeUpdate={(e) => controller.setCurrentTime(e.currentTarget.currentTime)}
        />
      </CardContent>
    </Card>
  );
}
