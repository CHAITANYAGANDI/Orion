/**
 * Utterances, regrouped into turns.
 *
 * Diarization emits an utterance per pause, so one person talking for a minute
 * arrives as several segments. Rendered one row each that reads as a stack of
 * fragments with the same name repeated down the page; merged into a turn it
 * reads as someone talking.
 *
 * Shared rather than duplicated because reading a transcript and editing one
 * have to agree about where the paragraphs are. Two implementations of this
 * would eventually differ by an edge case, and the visible symptom would be the
 * page reflowing when you switch into edit mode — which loses the reader the
 * place they were about to correct.
 */

import type { TranscriptSegment } from "@/lib/types";

export interface Turn {
  speaker: string;
  /** Canonical identity, for colouring. Absent on pre-canonical transcripts. */
  speakerKey?: string | null;
  start: number;
  segments: TranscriptSegment[];
}

/**
 * Merge consecutive utterances by the same speaker into one turn.
 *
 * Consecutive is doing real work here: a one-word interjection between two of
 * someone's utterances is a different speaker, so it breaks the run and the
 * turn either side of it stays separate. Merging across it would put the
 * interjection's neighbours back together as one paragraph and lose the fact
 * that somebody else spoke in the middle — which is the bug this was reported
 * as, arriving by a different route.
 */
export function groupIntoTurns(segments: TranscriptSegment[]): Turn[] {
  const turns: Turn[] = [];
  for (const s of segments) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === s.speaker) {
      last.segments.push(s);
    } else {
      turns.push({
        speaker: s.speaker,
        speakerKey: s.speakerKey,
        start: s.start,
        segments: [s],
      });
    }
  }
  return turns;
}
