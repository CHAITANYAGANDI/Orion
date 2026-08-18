"use client";

/**
 * The outline as a way in, rather than as a thing to read.
 *
 * Shown in the rail beside the transcript, and only there. Beside the summary
 * it would be the same list twice — the outline is already on that page, in
 * full, a few inches to the left. Beside the transcript it is the only thing
 * that makes an hour of speech navigable, because a transcript has no headings
 * of its own.
 *
 * Headings only; the bullets belong to the summary. Repeating them here would
 * make the rail as long as the document it exists to help you move around.
 */

import * as React from "react";
import type { SummarySection } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { timecode } from "@/lib/format";

export function OutlineNav({
  sections,
  onSeek,
}: {
  sections: SummarySection[];
  onSeek: (seconds: number) => void;
}) {
  const groups = sections
    .filter((s) => s.kind === "outline")
    .flatMap((s) => s.groups)
    .filter((g) => g.heading.trim());

  if (groups.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          This summary has no outline. Meetings summarized before templates
          existed have none, and a template without an outline section produces
          none.
        </CardContent>
      </Card>
    );
  }

  const anchored = groups.filter((g) => g.startSeconds != null).length;

  return (
    <Card>
      <CardContent className="space-y-1 py-4">
        {groups.map((g, i) =>
          g.startSeconds != null ? (
            <button
              key={i}
              type="button"
              onClick={() => onSeek(g.startSeconds as number)}
              className="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
            >
              <span className="tabular shrink-0 font-mono text-xs text-muted-foreground">
                {timecode(g.startSeconds)}
              </span>
              <span className="min-w-0 flex-1 text-sm">{g.heading}</span>
            </button>
          ) : (
            /*
             * Shown, but inert.
             *
             * Hiding an unanchored heading would make this list disagree with
             * the outline on the Summary tab, leaving a reader to wonder which
             * topics went missing and why. Making it clickable and sending it
             * to 0:00, or to the nearest heading that does have a time, is
             * worse still: a link that lands on the wrong minute is
             * indistinguishable from a transcript that contradicts its own
             * summary, and there is no way for the reader to tell which of the
             * two is broken.
             */
            <p
              key={i}
              className="px-2 py-1.5 text-sm text-muted-foreground/60"
              title="This topic could not be placed in the transcript"
            >
              {g.heading}
            </p>
          ),
        )}

        {/* Said once, at the bottom, and only when it applies. Without it a
            reader who clicks two greyed headings concludes the page is broken. */}
        {anchored < groups.length && (
          <p className="border-t px-2 pt-3 text-xs text-muted-foreground">
            Greyed topics could not be matched to a line in the transcript, so
            there is nowhere to jump to.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
