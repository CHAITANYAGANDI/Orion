"use client";

/**
 * One panel could not be fetched, and the page says so instead of guessing.
 *
 * <h2>What this replaces</h2>
 *
 * <p>Nothing. That is the point — there was no error state for the transcript,
 * the summary or the action items, so a failed request for any of them fell
 * through to that panel's empty message: "Transcript unavailable.", "No summary
 * available.", "No action items were extracted." Three confident sentences
 * about somebody's meeting, produced by three failures to reach the server.
 *
 * <h2>What it says, and what it refuses to say</h2>
 *
 * <p>Two lines. The first names what did not load; the second says the thing is
 * still there, because that is the fact the reader needs and the one the empty
 * message contradicted. Then the action that can actually help.
 *
 * <p>No status code, no message from the server, no URL. The cause is in the
 * network tab for whoever wants it; on the page it is noise at best, and at
 * worst it describes the shape of the backend on a screen anybody can reach.
 *
 * <p>`role="alert"` because this replaces content the reader was waiting for.
 * Somebody who has already moved on would otherwise never learn it did not
 * arrive.
 *
 * <h2>Why one component for three panels and not for all five</h2>
 *
 * <p>Home and the meeting page keep their own — {@link HomeLoadError} and
 * {@link MeetingLoadError} — because they are not the same screen. Those two
 * replace the <em>whole page</em> and have to offer a way out of it (a link
 * back to the conversations); this replaces one card inside a page that is
 * otherwise fine, and a "back to your conversations" button inside a working
 * meeting would be a strange thing to draw. Same rule, same wording,
 * deliberately different affordances.
 */

import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ResourceLoadError({
  title,
  detail,
  onRetry,
  retrying = false,
}: {
  /** What failed, named: "Couldn't load the summary". */
  title: string;
  /**
   * Why it is worth trying again. Says the resource still exists — the whole
   * difference between this and the empty state it replaced.
   */
  detail: string;
  onRetry: () => void;
  /** A retry already in flight, so the button cannot be queued up twice. */
  retrying?: boolean;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-lg border border-dashed px-4 py-10 text-center"
    >
      <RotateCw className="h-6 w-6 text-muted-foreground" />
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{detail}</p>
      <Button variant="outline" size="sm" className="mt-4" disabled={retrying} onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
