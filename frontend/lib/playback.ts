/**
 * Playback moves that are driven by the transcript rather than by the audio.
 *
 * Skip-silence, jump-to-speaker and play-highlights-only all look like audio
 * features and none of them are. Recallix already knows, to the word, when
 * somebody was speaking and who — so a gap between utterances *is* the silence,
 * and a change of `speaker` *is* the boundary. Deriving them from the
 * transcript is both free and exact, where an amplitude-based implementation
 * would be neither: it would need the samples decoded in the browser, and it
 * would still guess at the quiet parts of speech.
 *
 * All of it is pure and time-based so it can be tested without a media element,
 * which is the only way any of this is testable at all — jsdom has no playback.
 */

import type { TranscriptMoment, TranscriptSegment } from "@/lib/types";

/** A stretch of the recording, in seconds. */
export interface Span {
  start: number;
  end: number;
}

/** One continuous stretch of one person talking. */
export interface SpeakerTurn extends Span {
  speaker: string;
  /** Canonical identity, so the timeline band matches the transcript avatar. */
  speakerKey?: string | null;
}

/**
 * Merge consecutive utterances by the same speaker.
 *
 * Diarization emits an utterance per pause, so "the next speaker" is not the
 * next segment — it is the next segment whose speaker differs. Without this,
 * a jump-to-next-speaker button would advance a second and a half into the
 * same person's sentence.
 */
export function speakerTurns(segments: TranscriptSegment[]): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  for (const s of segments) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === s.speaker) {
      last.end = Math.max(last.end, s.end);
    } else {
      // The key rides along so the band under the scrubber is coloured from
      // the same identity as the avatar beside the turn. Merging still keys on
      // the displayed name: two speakers renamed to the same person are one
      // person, and drawing a boundary between them would contradict the
      // transcript.
      turns.push({ start: s.start, end: s.end, speaker: s.speaker, speakerKey: s.speakerKey });
    }
  }
  return turns;
}

/**
 * Where the next speaker starts after `at`, or null at the end.
 *
 * A small lead-in tolerance stops the button becoming a no-op when the playhead
 * is a few milliseconds short of a boundary it has effectively reached.
 */
export function nextSpeakerStart(turns: SpeakerTurn[], at: number): number | null {
  const next = turns.find((t) => t.start > at + 0.05);
  return next ? next.start : null;
}

/**
 * Where the previous speaker started.
 *
 * Restarts the current turn first, the way a track-back button on a music
 * player does: pressing it once means "from the top of this bit", and only a
 * second press goes further back. Without that, hearing one line again requires
 * going back and then forward.
 */
export function previousSpeakerStart(turns: SpeakerTurn[], at: number): number | null {
  const RESTART_WINDOW = 2;
  const current = [...turns].reverse().find((t) => t.start <= at);
  if (!current) return turns.length > 0 ? turns[0].start : null;

  if (at - current.start > RESTART_WINDOW) return current.start;

  const index = turns.indexOf(current);
  return index > 0 ? turns[index - 1].start : current.start;
}

/** Default gap worth skipping. Shorter than this and the jump is more jarring
 *  than the pause it removes. */
export const MIN_SILENCE = 1;

/**
 * Where to jump to if `at` is sitting in silence, or null if it is not.
 *
 * "Silence" is any stretch no utterance covers — including before the first
 * word, which on a recording that starts with people joining is often the
 * longest dead air in the file.
 *
 * Returns null rather than the current position when there is nothing to skip,
 * so the caller can tell "no move needed" from "move to here" without
 * comparing floats.
 */
export function silenceSkip(
  segments: TranscriptSegment[],
  at: number,
  minGap: number = MIN_SILENCE,
): number | null {
  if (segments.length === 0) return null;

  if (at < segments[0].start - 0.05) {
    return segments[0].start - at >= minGap ? segments[0].start : null;
  }

  for (let i = 0; i < segments.length - 1; i++) {
    const gapStart = segments[i].end;
    const gapEnd = segments[i + 1].start;
    if (gapEnd - gapStart < minGap) continue;
    // Inside this gap, and not already effectively at its far end.
    if (at >= gapStart && at < gapEnd - 0.05) return gapEnd;
  }
  return null;
}

/**
 * The stretches a "play highlights only" pass should cover.
 *
 * Bookmarks are excluded: they mark an instant, not a passage, so they have no
 * duration to play. Overlapping marks are merged — two highlights on the same
 * sentence must not make the playhead stutter between them.
 */
export function highlightSpans(moments: TranscriptMoment[]): Span[] {
  const spans = moments
    .filter((m) => m.endSeconds > m.startSeconds)
    .map((m) => ({ start: m.startSeconds, end: m.endSeconds }))
    .sort((a, b) => a.start - b.start);

  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

export function insideSpan(spans: Span[], at: number): boolean {
  return spans.some((s) => at >= s.start && at < s.end);
}

/**
 * Where a highlights-only pass should go next, or null when it is finished.
 *
 * Null means stop rather than wrap: silently looping back to the top would make
 * a short set of highlights play for ever.
 */
export function nextSpanStart(spans: Span[], at: number): number | null {
  const next = spans.find((s) => s.start > at);
  return next ? next.start : null;
}

/**
 * How long the recording is: what the element knows, or what the server
 * measured when it could not.
 *
 * Every recording Recallix makes itself is WebM from the browser's
 * `MediaRecorder`, and a `MediaRecorder` cannot write a duration. It is muxing
 * a stream of unknown length, so it emits a Segment header of unknown size and
 * no Duration element and no Cues — verified on a stored recording, whose
 * header runs `Segment` -> `01 ff ff ff ff ff ff ff` -> `Info` with a
 * TimecodeScale and nothing else. A browser handed that reports
 * `duration === Infinity` for the whole file, however much of it has arrived.
 *
 * The consequence on screen was a scrubber pinned at zero for the length of the
 * recording and an end time of `00:00`, on every meeting anybody recorded
 * rather than uploaded: `progressFraction` divides by a duration and correctly
 * refuses to divide by an unknown one, so the fraction was always zero.
 *
 * The server already knows the answer — the transcription pipeline measures the
 * audio and stores `durationSeconds`, and the page prints it beside the date —
 * so nothing has to be fetched or estimated. The element still wins when it has
 * a real number: an uploaded MP3 or MP4 carries an exact duration in its own
 * header, and that is a better answer than a pipeline's rounded seconds.
 *
 * The alternative fix, seeking to a huge offset to make the browser scan for
 * the end and then seeking back, is deliberately not used here: it costs a
 * download of the entire file before playback can start and is audible as a
 * jump on a slow connection.
 *
 * @param reported what the media element says, which may be Infinity or NaN.
 * @param known what the server measured, in seconds, if it has.
 */
export function playbackDuration(reported: number, known?: number | null): number {
  if (Number.isFinite(reported) && reported > 0) return reported;
  if (known != null && Number.isFinite(known) && known > 0) return known;
  return 0;
}

/**
 * Fraction of the way through, clamped to [0, 1].
 *
 * Guards a zero or unknown duration, which is what a media element reports
 * before metadata loads — and NaN in a CSS width silently renders nothing.
 */
export function progressFraction(currentTime: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(1, Math.max(0, currentTime / duration));
}

/** Seconds at a fraction of the way along the scrubber. */
export function seekTarget(fraction: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(duration, Math.max(0, fraction * duration));
}

/** Speeds offered, in the order the menu lists them. */
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
