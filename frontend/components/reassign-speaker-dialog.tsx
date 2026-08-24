"use client";

/**
 * "Wrong speaker" — move the selected words to somebody else.
 *
 * <p>The manual repair for a diarization mistake. Automatic diarization is not
 * perfect, and the case this exists for is specific: a provider that buries a
 * short reply inside the other person's turn. "Yes, sir." arriving as words
 * 8-9 of a twenty-four-word utterance attributed to the wrong voice is not
 * something any rename can fix, because the rest of that utterance is correctly
 * attributed.
 *
 * <p>So the unit here is words, not turns. The dialog shows exactly what is
 * moving, quoted, because moving the wrong words is easy to do by a stray drag
 * and hard to notice afterwards — the transcript still reads plausibly.
 *
 * <p>It lists only speakers the meeting already has. Inventing a participant
 * from this dialog would be a different feature with different consequences
 * (they would appear in the talk-time chart, the summary and every export), and
 * conflating the two would let a mis-click create a person.
 */

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SpeakerAvatar } from "@/components/speaker-avatar";
import { cn } from "@/lib/utils";
import type { SpeakerStats } from "@/lib/types";

export interface ReassignTarget {
  segmentId: string;
  /** Zero-based, inclusive. Undefined for a whole turn. */
  fromWord?: number;
  toWord?: number;
  /** What is moving, for the confirmation line. */
  quote: string;
  /** The canonical speaker these words currently belong to. */
  currentKey?: string | null;
}

export function ReassignSpeakerDialog({
  target,
  speakers,
  busy,
  onClose,
  onConfirm,
}: {
  target: ReassignTarget | null;
  speakers: SpeakerStats[];
  busy?: boolean;
  onClose: () => void;
  onConfirm: (speakerKey: string) => void;
}) {
  // Anyone but whoever already has these words: "move it to where it already
  // is" is not an action, and offering it invites a click that does nothing.
  const options = React.useMemo(
    () =>
      speakers.filter(
        (s) => s.speakerKey && s.speakerKey !== (target?.currentKey ?? null),
      ),
    [speakers, target?.currentKey],
  );

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Who said this?</DialogTitle>
          <DialogDescription>
            Only these words move. Every other turn stays exactly as it is.
          </DialogDescription>
        </DialogHeader>

        {target?.quote ? (
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm italic">
            “{target.quote.length > 180 ? `${target.quote.slice(0, 180)}…` : target.quote}”
          </p>
        ) : null}

        {options.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            This meeting only has one speaker, so there is nobody to move it to.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {options.map((s) => (
              <button
                key={s.speakerKey}
                type="button"
                disabled={busy}
                onClick={() => onConfirm(s.speakerKey as string)}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm",
                  "hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                  "disabled:pointer-events-none disabled:opacity-50",
                )}
              >
                <SpeakerAvatar name={s.speaker} speakerKey={s.speakerKey} />
                <span className="font-medium">{s.speaker}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
