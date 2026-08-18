import { speakerColor } from "@/lib/speakers";
import { cn } from "@/lib/utils";

/**
 * The coloured initial beside a turn.
 *
 * Shared between reading a transcript and editing one so the two views line up
 * column for column — an edit mode that reflowed the page would make the reader
 * find their place again on every toggle.
 *
 * `aria-hidden` because the speaker's name is already written next to it in
 * text; announcing "P" before "Priya" is noise.
 */
export function SpeakerAvatar({ name }: { name: string }) {
  const initial = (name.trim()[0] || "?").toUpperCase();
  return (
    <div
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white",
        speakerColor(name),
      )}
      aria-hidden
    >
      {initial}
    </div>
  );
}
