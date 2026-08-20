/**
 * One speaker, one colour, everywhere.
 *
 * Lives here rather than beside the transcript because the player's timeline
 * bands and the transcript's avatars are the same claim about the same person —
 * if they disagree, the coloured stripe under the scrubber becomes actively
 * misleading rather than merely decorative.
 *
 * Picked by a hash of an identity rather than by position, so a speaker keeps
 * their colour when a rename reorders the list, and looks the same on every
 * visit.
 *
 * That identity is the canonical speaker key ("spk_2") where the transcript has
 * one, and the display name otherwise. Hashing the *name* alone was wrong in a
 * way that only showed up on the action it was meant to survive: renaming
 * Speaker 2 to Sarah changed the hash, so she changed colour at the moment she
 * acquired a name — and the coloured bands under the scrubber stopped agreeing
 * with the avatars beside the transcript. Transcripts recorded before canonical
 * keys existed have none, and fall back to the name exactly as before.
 */

/** Tailwind background classes, for the avatar. */
export const SPEAKER_COLORS = [
  "bg-blue-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-violet-500",
  "bg-rose-500",
  "bg-cyan-500",
  "bg-orange-500",
  "bg-indigo-500",
] as const;

/**
 * The same palette as raw CSS colours.
 *
 * The timeline draws dozens of thin bands with computed widths, which is
 * inline-style territory rather than utility classes — but it has to be the
 * same eight colours in the same order, so both are derived from one index.
 */
export const SPEAKER_HEX = [
  "#3b82f6",
  "#f59e0b",
  "#10b981",
  "#8b5cf6",
  "#f43f5e",
  "#06b6d4",
  "#f97316",
  "#6366f1",
] as const;

/**
 * What a speaker is coloured by: their canonical key, or their name.
 *
 * Exported because the callers hold different shapes — a segment, a turn, a
 * stats row — and all three have to agree, or the timeline and the transcript
 * disagree about who is blue.
 */
export function speakerIdentity(
  name: string,
  key?: string | null,
): string {
  return key && key.trim() ? key.trim() : name;
}

export function speakerIndex(identity: string): number {
  let hash = 0;
  for (let i = 0; i < identity.length; i++) {
    hash = (hash * 31 + identity.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % SPEAKER_COLORS.length;
}

export function speakerColor(name: string, key?: string | null): string {
  return SPEAKER_COLORS[speakerIndex(speakerIdentity(name, key))];
}

export function speakerHex(name: string, key?: string | null): string {
  return SPEAKER_HEX[speakerIndex(speakerIdentity(name, key))];
}
