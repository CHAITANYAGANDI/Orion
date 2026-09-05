"use client";

/**
 * The transcript, read in another language.
 *
 * <p>A separate, read-only view rather than the same panel with different text
 * in it, and the reason is not laziness. The editable transcript lets you
 * correct a line, highlight a passage and quote it into a note — all three of
 * which record character offsets or exact words. Run any of them against
 * translated text and what gets saved is wrong in a way nobody can see later: a
 * "correction" that overwrites the recording's actual words with a translation
 * of them, a highlight whose offsets point into a sentence that was never
 * spoken, a quote attributed to somebody who said something else.
 *
 * <p>So this view plays and reads, and says plainly where to go to edit. The
 * speaker, the timings and the ordering all come from the live segments, so
 * renaming a speaker changes every language at once.
 */

import * as React from "react";
import { Search, X } from "lucide-react";
import { timecode } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import type { MeetingTranslation, TranscriptSegment } from "@/lib/types";

export function TranslatedTranscript({
  segments,
  translation,
  currentTime,
  onSeek,
  onShowOriginal,
}: {
  /** The live segments — speaker, start and end are read from these. */
  segments: TranscriptSegment[];
  translation: MeetingTranslation;
  currentTime: number;
  onSeek: (seconds: number) => void;
  onShowOriginal: () => void;
}) {
  const [query, setQuery] = React.useState("");

  const text = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const line of translation.segments) map.set(line.id, line.text);
    return map;
  }, [translation.segments]);

  const lines = React.useMemo(
    () =>
      segments
        .map((s) => ({ segment: s, text: (s.id && text.get(s.id)) || s.text }))
        // A line the translation does not cover is one recorded after it was
        // made. Shown in the original rather than dropped: a gap in a
        // transcript is indistinguishable from a silence in the room.
        .filter((l) => !query || l.text.toLowerCase().includes(query.toLowerCase())),
    [segments, text, query],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface-raised px-3 py-2 text-callout text-ink-2">
        <span>
          Reading in {translation.languageName}. Corrections and highlights work
          on the original.
        </span>
        <button
          onClick={onShowOriginal}
          className="text-brand-text underline-offset-2 hover:underline"
        >
          Show the original
        </button>
      </div>

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-4" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search the ${translation.languageName} transcript`}
          aria-label="Search the translated transcript"
          className="border-edge bg-surface-raised pl-9"
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-4 transition-colors hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {lines.length === 0 ? (
        <p className="py-8 text-center text-callout text-ink-4">
          Nothing matches “{query}”.
        </p>
      ) : (
        <ol
          // Set from the language rather than the content: Arabic and Hebrew
          // rendered left-to-right are not merely ugly, they are hard to read.
          dir={translation.rightToLeft ? "rtl" : "ltr"}
          className="space-y-5"
        >
          {lines.map(({ segment, text: line }) => {
            const active =
              currentTime >= (segment.start || 0) && currentTime < (segment.end || 0);
            return (
              <li key={segment.id ?? `${segment.start}`} className="flex gap-3">
                <button
                  onClick={() => onSeek(segment.start || 0)}
                  dir="ltr"
                  className="tabular shrink-0 font-mono text-cap text-ink-4 transition-colors hover:text-brand-text"
                  aria-label={`Play from ${timecode(segment.start || 0)}`}
                >
                  {timecode(segment.start || 0)}
                </button>
                <div className={cn("min-w-0 rounded-sm px-1", active && "bg-brand/10")}>
                  {/* Sans for the name, serif for the words. The same rule
                      as the original transcript, because this is the same
                      document in another language rather than a different
                      kind of thing. */}
                  <p className="text-cap font-headline uppercase text-ink-3">{segment.speaker}</p>
                  <p className="v2-read">{line}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
