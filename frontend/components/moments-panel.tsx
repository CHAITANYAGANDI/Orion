"use client";

/**
 * Everything marked on one transcript, in the order it was said.
 *
 * The inline highlights answer "what did I mark here"; this answers "what did I
 * mark in this meeting", which is the question anyone returning to a two-hour
 * recording actually has. Ordered by position rather than by when it was
 * marked, so reading down the list is reading the meeting.
 *
 * A mark whose words were rewritten since is shown rather than dropped — see
 * `isOrphaned`. Dropping it would look like the app had lost the annotation;
 * showing it with its quote and timestamp lets the reader find the moment
 * themselves, which is all that was lost.
 */

import * as React from "react";
import { toast } from "sonner";
import { Bookmark, Highlighter, MessageSquare, Trash2, Unlink, Check, Pencil } from "lucide-react";
import { useDeleteMomentMutation, useUpdateMomentMutation } from "@/lib/api";
import type { MomentKind, TranscriptMoment } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { timecode } from "@/lib/format";
import { isOrphaned } from "@/lib/moments";
import { cn } from "@/lib/utils";

const ICONS: Record<MomentKind, React.ComponentType<{ className?: string }>> = {
  HIGHLIGHT: Highlighter,
  BOOKMARK: Bookmark,
  NOTE: MessageSquare,
};

export function MomentsPanel({
  meetingId,
  moments,
  segmentText,
  onSeek,
}: {
  meetingId: string;
  moments: TranscriptMoment[];
  /** Current text of a segment, for deciding whether a mark still resolves. */
  segmentText: (segmentId: string) => string | undefined;
  onSeek: (seconds: number) => void;
}) {
  if (moments.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        Nothing marked yet. Select any part of the transcript to highlight it,
        note it, or turn it into an action item.
      </p>
    );
  }

  return (
    <ul className="divide-y">
      {moments.map((m) => (
        <MomentRow
          key={m.id}
          meetingId={meetingId}
          moment={m}
          orphaned={isOrphaned(m, segmentText)}
          onSeek={onSeek}
        />
      ))}
    </ul>
  );
}

function MomentRow({
  meetingId,
  moment,
  orphaned,
  onSeek,
}: {
  meetingId: string;
  moment: TranscriptMoment;
  orphaned: boolean;
  onSeek: (seconds: number) => void;
}) {
  const Icon = ICONS[moment.kind];
  const [remove, { isLoading: removing }] = useDeleteMomentMutation();
  const [update, { isLoading: saving }] = useUpdateMomentMutation();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(moment.body);

  async function onDelete() {
    try {
      await remove({ id: moment.id, meetingId }).unwrap();
    } catch {
      toast.error("Could not remove that mark.");
    }
  }

  async function onSave() {
    const body = draft.trim();
    // A note with nothing in it is refused by the server, so catching it here
    // keeps the error out of a toast for something the user can see.
    if (moment.kind === "NOTE" && !body) {
      setDraft(moment.body);
      setEditing(false);
      return;
    }
    try {
      await update({ id: moment.id, meetingId, body }).unwrap();
      setEditing(false);
    } catch {
      toast.error("Could not save that note.");
    }
  }

  return (
    <li className="group py-3">
      <div className="flex items-start gap-3">
        <Icon
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0",
            moment.kind === "HIGHLIGHT" ? "text-amber-500" : "text-muted-foreground",
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <button
              onClick={() => onSeek(moment.startSeconds)}
              className="font-mono hover:text-foreground hover:underline"
              aria-label={`Play from ${timecode(moment.startSeconds)}`}
            >
              {timecode(moment.startSeconds)}
            </button>
            {moment.speaker && <span>{moment.speaker}</span>}
            {orphaned && (
              <span
                className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-500"
                title="The transcript line this was attached to has been edited, so it is no longer shown inline."
              >
                <Unlink className="h-3 w-3" /> line edited
              </span>
            )}
          </div>

          {moment.quote && (
            <p className="border-l-2 border-muted-foreground/30 pl-2 text-sm italic">
              “{moment.quote}”
            </p>
          )}

          {editing ? (
            <div className="space-y-2 pt-1">
              <Textarea
                autoFocus
                rows={3}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setDraft(moment.body);
                    setEditing(false);
                  }
                }}
                placeholder={moment.kind === "BOOKMARK" ? "Label this moment…" : "Your note…"}
              />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={onSave} disabled={saving}>
                  <Check className="h-3.5 w-3.5" /> Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDraft(moment.body);
                    setEditing(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            moment.body && <p className="whitespace-pre-wrap text-sm">{moment.body}</p>
          )}
        </div>

        {/* Hidden until hover so a list of marks reads as a list of marks, but
            always reachable by keyboard. */}
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {/* A highlight has nothing to write in; the other two do. */}
          {moment.kind !== "HIGHLIGHT" && !editing && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => setEditing(true)}
              aria-label={moment.kind === "NOTE" ? "Edit note" : "Edit label"}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={onDelete}
            disabled={removing}
            aria-label="Remove mark"
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>
    </li>
  );
}
