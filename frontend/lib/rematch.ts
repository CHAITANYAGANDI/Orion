import type { SpeakerRematchResult } from "@/lib/types";

/**
 * What to say after a rematch.
 *
 * Its own module rather than a few lines in the meeting page, because this
 * wording is the feature's entire visible surface. A rematch changes names in a
 * transcript the user may not be looking at; this sentence is usually the only
 * evidence anything happened, and the three outcomes it has to keep apart are
 * easy to collapse into one by accident.
 *
 * - **Somebody matched.** A count and the names.
 * - **Nobody matched.** Ordinary and correct: the meeting had unresolved
 *   speakers, they were compared against every known voice, and none of them
 *   cleared the bar. Nothing is wrong and there is nothing to do.
 * - **It could not run.** Voice matching switched off, not configured on this
 *   server, no recording left to analyse. The user's next move is completely
 *   different from the case above — one of them is "there is a setting to turn
 *   on" — so saying "no matches found" here would leave somebody pressing a
 *   button that can never work.
 *
 * There is no confidence figure in any of these and nowhere to put one. The
 * matcher thresholds on cosine similarity between voice embeddings, which is
 * the right quantity to threshold on and is not a calibrated probability:
 * "94% confident it's Sarah" would be a number nothing ever computed.
 *
 * Separate from `lib/speakers`, which is about what colour somebody is.
 */
export type RematchTone = "success" | "info" | "error";

export interface RematchMessage {
  tone: RematchTone;
  text: string;
  /** The names, when there are any. Shown under the headline. */
  detail?: string;
}

export function rematchMessage(result: SpeakerRematchResult): RematchMessage {
  if (result.unavailable) {
    return { tone: "info", text: result.unavailable };
  }
  if (result.matched === 0) {
    return { tone: "success", text: "No new speaker matches found." };
  }
  // Speakers, not turns. One person whose eleven turns were relabelled is one
  // speaker rematched; "11 speakers rematched" would be a lie about a
  // two-person meeting, and the transcript is right there to check it against.
  const plural = result.matched === 1 ? "" : "s";
  return {
    tone: "success",
    text: `${result.matched} speaker${plural} rematched.`,
    detail: result.names.length > 0 ? result.names.join(", ") : undefined,
  };
}
