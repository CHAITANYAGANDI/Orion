/**
 * One speaker, one colour, everywhere.
 *
 * Lives here rather than beside the transcript because the player's timeline
 * bands and the transcript's avatars are the same claim about the same person —
 * if they disagree, the coloured stripe under the scrubber becomes actively
 * misleading rather than merely decorative.
 *
 * Picked by a hash of the name rather than by position, so a speaker keeps
 * their colour when a rename reorders the list, and looks the same on every
 * visit.
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

export function speakerIndex(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % SPEAKER_COLORS.length;
}

export function speakerColor(name: string): string {
  return SPEAKER_COLORS[speakerIndex(name)];
}

export function speakerHex(name: string): string {
  return SPEAKER_HEX[speakerIndex(name)];
}
