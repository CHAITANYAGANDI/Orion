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
 * <p>It lists the speakers the meeting already has, and — separately, below a
 * rule — one more option: the words belong to somebody diarization never
 * separated out at all. A fifth voice folded into Speaker 1 cannot be repaired
 * by picking from a list that does not contain them, and before this the
 * correction could not be expressed.
 *
 * <p><b>That option asks twice.</b> Creating a speaker has consequences a
 * reassignment does not — they appear in the talk-time chart, the summary and
 * every export — so it must not be reachable by the stray click that the rest of
 * this list is one press away from. The confirm step is the whole difference
 * between "move these words" and "there was another person here".
 *
 * <p>Meeting-local, and only that. Reverie holds no cross-meeting speaker
 * record; this creates a canonical identity in this transcript and nothing
 * anywhere else.
 */

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Plus, Loader2 } from "lucide-react";
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
  error,
  onClose,
  onConfirm,
  onConfirmNew,
}: {
  target: ReassignTarget | null;
  speakers: SpeakerStats[];
  busy?: boolean;
  /** Why the last attempt failed. Shown here rather than only in a toast. */
  error?: string | null;
  onClose: () => void;
  onConfirm: (speakerKey: string) => void;
  /** The words belong to somebody not in this meeting yet. */
  onConfirmNew: () => void;
}) {
  // The second step of the new-speaker path. Local, and reset whenever the
  // dialog opens on a different selection: a confirm left standing from the
  // last line would be a click away from creating a speaker for this one.
  const [confirmingNew, setConfirmingNew] = React.useState(false);
  // Which answer is in flight. `busy` says a request is running; this says
  // which one, so the spinner appears on the row the user actually pressed
  // rather than on all of them or on the dialog as a whole.
  const [pendingKey, setPendingKey] = React.useState<string | null>(null);
  React.useEffect(() => {
    setConfirmingNew(false);
  }, [target?.segmentId, target?.fromWord, target?.toWord]);
  React.useEffect(() => {
    // Cleared when the request ends. On success the dialog closes anyway; on
    // failure it stays open, and a spinner left running on a row that already
    // failed would contradict the error printed beneath it.
    if (!busy) setPendingKey(null);
  }, [busy]);
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
    // Not dismissable while a correction is running. Cancel is already disabled
    // then, and leaving the X and Escape live would contradict it — closing
    // would hide a request that is still going to land, leaving the user unsure
    // whether the words moved.
    <Dialog open={target !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md" aria-busy={busy}>
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

        {/* Named work, not a bare spinner. The correction rebuilds the flat
            transcript and re-indexes chat before the server answers, so this
            can run for several seconds — long enough that "something is
            happening" is not enough to stop it reading as stuck. `role=status`
            announces it without stealing focus from the button just pressed. */}
        {busy ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
            {confirmingNew
              ? "Creating the speaker and moving the words."
              : "Moving the words."}{" "}
            The transcript and chat update with them.
          </p>
        ) : null}

        {confirmingNew ? (
          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium">Assign to a new speaker</p>
              <p className="text-sm text-muted-foreground">
                This line belongs to someone who isn&apos;t listed yet.
              </p>
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setConfirmingNew(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              {/* Disabled while the request is in flight, so a second press
                  cannot allocate a second identity for one correction. The
                  label does not change with it: this is the button they were
                  told to press, and renaming it mid-press reads as a different
                  button. The spinner carries the state instead. */}
              <Button onClick={onConfirmNew} disabled={busy}>
                {busy ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                ) : null}
                Create &amp; assign
              </Button>
            </div>
          </div>
        ) : (
          <>
            {options.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nobody else in this meeting can take these words — but they may
                belong to someone who isn&apos;t listed yet.
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {options.map((s) => (
                  <button
                    key={s.speakerKey}
                    type="button"
                    disabled={busy}
                    aria-busy={busy && pendingKey === s.speakerKey}
                    onClick={() => {
                      setPendingKey(s.speakerKey as string);
                      onConfirm(s.speakerKey as string);
                    }}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm",
                      "hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                      "disabled:pointer-events-none",
                      // The chosen row stays legible while it works; the ones
                      // not chosen fade, so the dimming reads as "not this one"
                      // rather than as the whole dialog going dead.
                      busy && pendingKey !== s.speakerKey && "opacity-50",
                    )}
                  >
                    <SpeakerAvatar name={s.speaker} speakerKey={s.speakerKey} />
                    <span className="font-medium">{s.speaker}</span>
                    {busy && pendingKey === s.speakerKey ? (
                      <Loader2
                        className="ml-auto h-4 w-4 shrink-0 animate-spin text-muted-foreground"
                        aria-hidden
                      />
                    ) : null}
                  </button>
                ))}
              </div>
            )}

            {/* Below a rule, because it is a different kind of answer: every
                option above moves words to somebody who is already here. */}
            <div className="border-t pt-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmingNew(true)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm",
                  "hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                  "disabled:pointer-events-none disabled:opacity-50",
                )}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-dashed">
                  <Plus className="h-4 w-4" />
                </span>
                <span className="font-medium">New speaker</span>
              </button>
            </div>

            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <div className="flex justify-end">
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
