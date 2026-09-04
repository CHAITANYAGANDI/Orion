"use client";

/**
 * The recording, with controls built around the transcript.
 *
 * The native `controls` attribute is gone and that is the whole point. People
 * use this to check the notes against what was actually said, which means the
 * moves they need are "back ten seconds", "who spoke next", "skip the dead
 * air", "half speed on that bit" — and a browser's default control strip offers
 * none of them, hides playback rate behind a context menu, and looks different
 * in every browser.
 *
 * Everything non-obvious is driven by the transcript rather than by the audio
 * signal; see `lib/playback.ts` for why that is both cheaper and more accurate.
 */

import * as React from "react";
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Gauge,
  AudioLines,
  Highlighter,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import type { TranscriptMoment, TranscriptSegment } from "@/lib/types";
import {
  MIN_SILENCE,
  SPEEDS,
  highlightSpans,
  insideSpan,
  nextSpanStart,
  nextSpeakerStart,
  playbackDuration,
  previousSpeakerStart,
  progressFraction,
  seekTarget,
  silenceSkip,
  speakerTurns,
} from "@/lib/playback";
import { speakerHex } from "@/lib/speakers";
import { timecode } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * How often the playhead is published to React while playing, in milliseconds.
 *
 * Not a frame budget — a render budget. See the loop in `useAudioController`.
 */
const CLOCK_INTERVAL = 100;

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

  /*
   * The clock, read on a frame and published on a budget.
   *
   * `timeupdate` fires roughly four times a second, which is fine for marking
   * which paragraph is playing but far too coarse to follow words: at normal
   * speaking pace several words pass between events, so the highlight jumps in
   * clumps. So the element is read every animation frame. What changed is what
   * happens next.
   *
   * ## Why it is not published every frame
   *
   * This value is passed down into the transcript, so every publish re-renders
   * several hundred segments. Doing that sixty times a second left React with
   * urgent work outstanding at all times, and an urgent update outranks a
   * transition — which is what an App Router navigation is. The symptom was
   * exact and reproducible: clicking Home while audio played did nothing at
   * all, and the moment you hit pause the app went straight to the page you
   * had asked for several minutes earlier. The navigation was never lost, it
   * was never allowed to finish rendering.
   *
   * Two things stop that, and both are needed. Publishing at most every
   * hundred milliseconds leaves the main thread idle in between, which is where
   * a route change gets rendered. And publishing inside `startTransition` puts
   * the clock in the same lane as the navigation rather than above it, so even
   * under load a playhead can never win against somebody trying to leave the
   * page.
   *
   * A hundred milliseconds is still two and a half times finer than
   * `timeupdate`, and shorter than the shortest spoken word, so the highlight
   * this loop exists for is unaffected.
   */
  React.useEffect(() => {
    let frame = 0;
    let published = -Infinity;

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const el = ref.current;
      if (!el || el.paused || el.ended) return;
      if (now - published < CLOCK_INTERVAL) return;
      published = now;
      // Read now, published later. A transition runs when React gets to it,
      // and by then the element has moved on — sampling inside the callback
      // would quietly make the playhead report a time from a different frame
      // than the one that decided to publish it.
      const at = el.currentTime;
      React.startTransition(() => setCurrentTime(at));
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

const NUDGE = 10;

export function AudioPlayer({
  src,
  controller,
  contentType,
  durationSeconds,
  segments = [],
  moments = [],
  onSourceExpired,
}: {
  src: string;
  controller: AudioController;
  /**
   * Ask the owner for a fresh `src`, because this one stopped working.
   *
   * `src` is a **presigned URL and it expires** — fifteen minutes, set by
   * `s3.presign-expiry-seconds`. Nothing refreshes it, so a page left open
   * longer than that holds a link the object store will refuse.
   *
   * What that looks like is not "an error": the recording plays perfectly from
   * whatever is already buffered and fails the moment it needs bytes it does
   * not have. Pausing, waiting, and pressing play again needs bytes. Clicking a
   * word further along needs bytes. Both went dead silently, because the two
   * `play()` calls in this file discard their rejection and the element had no
   * error listener at all.
   *
   * Optional: without it the player behaves as before, which is what the tests
   * that construct it directly rely on.
   */
  onSourceExpired?: () => void;
  /** MIME type of the stored media. Absent (older meetings) means audio. */
  contentType?: string | null;
  /**
   * How long the server measured the recording to be.
   *
   * Needed rather than nice to have: a browser recording is WebM with no
   * duration in it, and without this the scrubber cannot move and the end time
   * is 00:00. See `playbackDuration` in lib/playback.ts.
   */
  durationSeconds?: number | null;
  /** Drives skip-silence, speaker jumps and the coloured timeline. */
  segments?: TranscriptSegment[];
  /** Drives "highlights only". */
  moments?: TranscriptMoment[];
}) {
  const isVideo = !!contentType && contentType.startsWith("video/");
  // Stable, so it can be a real dependency of the callbacks and effects below
  // rather than something they have to be told to ignore. `controller.ref` is a
  // useRef object and never changes identity.
  const el = React.useCallback(() => controller.ref.current, [controller.ref]);

  const [playing, setPlaying] = React.useState(false);
  // What the element claims, which for a browser recording is Infinity. Kept
  // raw and reconciled below rather than sanitised on the way in, so the one
  // place that decides what the duration is can see both answers.
  const [reported, setReported] = React.useState(0);
  const [rate, setRate] = React.useState(1);
  const [volume, setVolume] = React.useState(1);
  const [muted, setMuted] = React.useState(false);
  const [skipSilence, setSkipSilence] = React.useState(false);
  const [highlightsOnly, setHighlightsOnly] = React.useState(false);

  const duration = playbackDuration(reported, durationSeconds);

  const turns = React.useMemo(() => speakerTurns(segments), [segments]);
  const spans = React.useMemo(() => highlightSpans(moments), [moments]);
  const hasHighlights = spans.length > 0;

  // Reflect whatever the element is actually doing. Playback can start or stop
  // without this component asking — a transcript click calls play(), and the
  // media session keys work whether or not we know about them.
  React.useEffect(() => {
    const media = el();
    if (!media) return;
    const sync = () => {
      setPlaying(!media.paused && !media.ended);
      setRate(media.playbackRate);
      setVolume(media.volume);
      setMuted(media.muted);
    };
    const onMeta = () => setReported(media.duration);

    sync();
    onMeta();
    media.addEventListener("play", sync);
    media.addEventListener("pause", sync);
    media.addEventListener("ended", sync);
    media.addEventListener("ratechange", sync);
    media.addEventListener("volumechange", sync);
    media.addEventListener("loadedmetadata", onMeta);
    media.addEventListener("durationchange", onMeta);
    return () => {
      media.removeEventListener("play", sync);
      media.removeEventListener("pause", sync);
      media.removeEventListener("ended", sync);
      media.removeEventListener("ratechange", sync);
      media.removeEventListener("volumechange", sync);
      media.removeEventListener("loadedmetadata", onMeta);
      media.removeEventListener("durationchange", onMeta);
    };
  }, [src, el]);

  /**
   * Where to come back to once a fresh `src` arrives, and whether to resume.
   *
   * Held in a ref rather than state because changing `src` remounts the source:
   * the element resets `currentTime` to zero and forgets it was playing, and
   * this is the only record of where the listener actually was.
   */
  const resumeAt = React.useRef<{ at: number; playing: boolean } | null>(null);
  /**
   * The `src` a recovery has already been asked for.
   *
   * One attempt per URL. A recording whose object is genuinely gone would
   * otherwise error, refetch, error, refetch — a network loop that looks like a
   * hang and is worse than the silence it replaced.
   */
  const recovering = React.useRef<string | null>(null);
  const [failed, setFailed] = React.useState(false);

  const recover = React.useCallback(() => {
    const media = el();
    if (!media) return;
    if (!onSourceExpired || recovering.current === src) {
      setFailed(true);
      return;
    }
    recovering.current = src;
    resumeAt.current = {
      // The element's own clock, falling back to the published one: a failed
      // seek can leave `currentTime` at the old position while the controller
      // already moved.
      at: Number.isFinite(media.currentTime) ? media.currentTime : controller.currentTime,
      playing: !media.paused && !media.ended,
    };
    onSourceExpired();
  }, [el, src, controller, onSourceExpired]);

  // A media element reports a dead URL through `error`, and only through it —
  // there is no rejected promise to catch when playback stalls mid-stream.
  React.useEffect(() => {
    const media = el();
    if (!media) return;
    const onError = () => recover();
    media.addEventListener("error", onError);
    return () => media.removeEventListener("error", onError);
  }, [el, recover]);

  // A fresh `src` landed. Put the listener back where they were.
  React.useEffect(() => {
    const media = el();
    const pending = resumeAt.current;
    if (!media || !pending) return;
    resumeAt.current = null;
    setFailed(false);
    const restore = () => {
      media.currentTime = pending.at;
      controller.setCurrentTime(pending.at);
      if (pending.playing) void media.play().catch(() => setFailed(true));
    };
    // Seeking before metadata lands is dropped by the browser, which would
    // silently restart an hour-long recording from the beginning.
    if (media.readyState >= 1) restore();
    else media.addEventListener("loadedmetadata", restore, { once: true });
  }, [src, el, controller]);

  const toggle = React.useCallback(() => {
    const media = el();
    if (!media) return;
    if (media.paused) void media.play().catch(() => recover());
    else media.pause();
  }, [el, recover]);

  const jumpTo = React.useCallback(
    (seconds: number) => {
      const media = el();
      if (!media) return;
      media.currentTime = Math.max(0, seconds);
      controller.setCurrentTime(media.currentTime);
    },
    [controller, el],
  );

  const nudge = React.useCallback(
    (by: number) => jumpTo((el()?.currentTime ?? 0) + by),
    [jumpTo, el],
  );

  /**
   * Enforce skip-silence and highlights-only while playing.
   *
   * Runs off the clock the controller is already reading rather than its own
   * loop, and only while playing — otherwise dragging the scrubber into a gap
   * would yank the playhead away from where it was deliberately put.
   *
   * Highlights-only takes precedence: it is the stricter filter, and the two
   * fighting over the playhead would be visible as a stutter.
   */
  React.useEffect(() => {
    if (!playing) return;
    const at = controller.currentTime;

    if (highlightsOnly && hasHighlights) {
      if (insideSpan(spans, at)) return;
      const next = nextSpanStart(spans, at);
      if (next === null) {
        el()?.pause();
        return;
      }
      jumpTo(next);
      return;
    }

    if (skipSilence) {
      const target = silenceSkip(segments, at, MIN_SILENCE);
      if (target !== null) jumpTo(target);
    }
  }, [
    controller.currentTime,
    playing,
    skipSilence,
    highlightsOnly,
    hasHighlights,
    spans,
    segments,
    jumpTo,
    el,
  ]);

  /**
   * Keyboard control.
   *
   * Deliberately inert while typing: the transcript has a find box and the page
   * has two chat inputs, and a space bar that pauses the recording mid-sentence
   * instead of typing a space is worse than no shortcut at all.
   */
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          toggle();
          break;
        case "ArrowLeft":
          e.preventDefault();
          nudge(-5);
          break;
        case "ArrowRight":
          e.preventDefault();
          nudge(5);
          break;
        case "j":
          e.preventDefault();
          nudge(-NUDGE);
          break;
        case "l":
          e.preventDefault();
          nudge(NUDGE);
          break;
        case "m": {
          e.preventDefault();
          const media = el();
          if (media) media.muted = !media.muted;
          break;
        }
        default:
          break;
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggle, nudge, el]);

  function scrub(e: React.MouseEvent<HTMLDivElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    jumpTo(seekTarget((e.clientX - box.left) / box.width, duration));
  }

  const fraction = progressFraction(controller.currentTime, duration);

  return (
    <Card>
      <CardContent className="space-y-2 py-3">
        {isVideo ? (
          <video
            ref={controller.ref as React.MutableRefObject<HTMLVideoElement | null>}
            src={src}
            playsInline
            preload="metadata"
            onTimeUpdate={(e) => controller.setCurrentTime(e.currentTarget.currentTime)}
            onClick={toggle}
            // Tall portrait clips would otherwise push the transcript off screen.
            className="max-h-[60vh] w-full rounded-md bg-black"
          />
        ) : (
          <audio
            ref={controller.ref as React.MutableRefObject<HTMLAudioElement | null>}
            src={src}
            preload="metadata"
            onTimeUpdate={(e) => controller.setCurrentTime(e.currentTarget.currentTime)}
            className="hidden"
          />
        )}

        {/* Scrubber, banded by who is speaking.
            The bands are why this is not a plain progress bar: on an hour-long
            recording they turn "find where the other person answers" from
            scrubbing blindly into looking. Silence shows as the gaps between
            them, which is the same information an amplitude waveform is usually
            being read for. */}
        <div
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(controller.currentTime)}
          aria-valuetext={`${timecode(controller.currentTime)} of ${timecode(duration)}`}
          onClick={scrub}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              nudge(-5);
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              nudge(5);
            }
          }}
          className="group relative h-6 cursor-pointer"
        >
          <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 overflow-hidden rounded-full bg-secondary">
            {duration > 0 &&
              turns.map((turn, i) => (
                <span
                  key={i}
                  aria-hidden
                  title={turn.speaker}
                  className="absolute inset-y-0 opacity-45"
                  style={{
                    left: `${(turn.start / duration) * 100}%`,
                    width: `${Math.max(0.15, ((turn.end - turn.start) / duration) * 100)}%`,
                    backgroundColor: speakerHex(turn.speaker, turn.speakerKey),
                  }}
                />
              ))}
            {/* Played-so-far, over the bands rather than replacing them, so the
                speaker layout stays readable ahead of and behind the playhead. */}
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 bg-foreground/25"
              style={{ width: `${fraction * 100}%` }}
            />
          </div>
          <span
            aria-hidden
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow ring-2 ring-background transition-transform group-hover:scale-125"
            style={{ left: `${fraction * 100}%` }}
          />
        </div>

        {/* Said out loud rather than left as a dead play button. This is only
            reached when a refreshed link failed too, so "try again" is honest
            advice and "reload the page" is the thing that actually works. */}
        {failed && (
          <p role="status" className="text-xs text-destructive">
            The recording could not be loaded. Reload the page to try again.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-x-1 gap-y-2">
          <IconButton
            label="Previous speaker"
            onClick={() => {
              const to = previousSpeakerStart(turns, controller.currentTime);
              if (to !== null) jumpTo(to);
            }}
            disabled={turns.length === 0}
          >
            <SkipBack className="h-4 w-4" />
          </IconButton>
          <IconButton label={`Back ${NUDGE} seconds`} onClick={() => nudge(-NUDGE)}>
            <RotateCcw className="h-4 w-4" />
          </IconButton>

          <button
            onClick={toggle}
            aria-label={playing ? "Pause" : "Play"}
            className="mx-1 flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform hover:scale-105"
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
          </button>

          <IconButton label={`Forward ${NUDGE} seconds`} onClick={() => nudge(NUDGE)}>
            <RotateCw className="h-4 w-4" />
          </IconButton>
          <IconButton
            label="Next speaker"
            onClick={() => {
              const to = nextSpeakerStart(turns, controller.currentTime);
              if (to !== null) jumpTo(to);
            }}
            disabled={turns.length === 0}
          >
            <SkipForward className="h-4 w-4" />
          </IconButton>

          <span className="ml-2 font-mono text-xs tabular-nums text-muted-foreground">
            {timecode(controller.currentTime)} / {timecode(duration)}
          </span>

          <div className="ml-auto flex flex-wrap items-center gap-1">
            {/* Skip silence, from the transcript's gaps rather than the signal's
                amplitude — exact, and free. */}
            <Toggle
              label="Skip silence"
              active={skipSilence}
              disabled={segments.length === 0 || highlightsOnly}
              onClick={() => setSkipSilence((v) => !v)}
            >
              <AudioLines className="h-4 w-4" />
            </Toggle>

            {/* Only offered when there is something marked; a toggle that can
                only ever produce silence is worse than an absent one. */}
            {hasHighlights && (
              <Toggle
                label="Play highlights only"
                active={highlightsOnly}
                onClick={() => setHighlightsOnly((v) => !v)}
              >
                <Highlighter className="h-4 w-4" />
              </Toggle>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  aria-label="Playback speed"
                  className="flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Gauge className="h-4 w-4" />
                  {rate}×
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {SPEEDS.map((s) => (
                  <DropdownMenuItem
                    key={s}
                    onSelect={() => {
                      const media = el();
                      if (media) media.playbackRate = s;
                    }}
                    className={cn(s === rate && "font-semibold")}
                  >
                    {s}×
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <IconButton
              label={muted ? "Unmute" : "Mute"}
              onClick={() => {
                const media = el();
                if (media) media.muted = !media.muted;
              }}
            >
              {muted || volume === 0 ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </IconButton>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              aria-label="Volume"
              onChange={(e) => {
                const media = el();
                if (!media) return;
                media.volume = Number(e.target.value);
                // Moving the slider off zero is an unmute request; leaving the
                // element muted would make the control appear to do nothing.
                media.muted = Number(e.target.value) === 0;
              }}
              className="h-1 w-20 cursor-pointer accent-[hsl(var(--primary))]"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Toggle({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-40",
        active
          ? "bg-primary/15 text-primary"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
