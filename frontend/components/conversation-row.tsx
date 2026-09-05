"use client";

/*
 * ONE MEETING, AS A ROW.
 *
 * <p>Lifted out of Home when Library was built, because both lists are the same
 * list under different filters — Home is what has not been filed, Library is
 * everything — and two drawings of one row is how a status pill ends up on one
 * screen and not the other. The component is unchanged from the one Home has
 * used since the processing row was folded into it; only its address is new.
 */

import Link from "next/link";
import { FileAudio, FileText, Youtube } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/status-badge";
import { ProcessingRow, useLiveMeetingStatus } from "@/components/processing-row";
import { formatDuration, isTerminal } from "@/lib/format";
import type { MeetingResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * One meeting in the list — and, while it is being made, how far along it is.
 *
 * <p>The processing row is the *same* row, not a separate section and not a
 * card of its own: a meeting has one place in this list and keeps it from the
 * moment it is saved. What is added is a status pill, the stage, a slim bar and
 * a percentage, plus a warning-tinted border so it is findable among nine
 * finished meetings without being a different kind of object. See
 * components/processing-row.
 *
 * <p>Clicking it opens the normal meeting route, exactly as a finished one does.
 */
export function ConversationRow({ meeting }: { meeting: MeetingResponse }) {
  const Icon =
    meeting.sourceType === "YOUTUBE"
      ? Youtube
      : meeting.sourceType === "DOCUMENT"
        ? FileText
        : FileAudio;

  // Live, because Home does not poll its list. Terminal meetings open no
  // subscription -- see the hook.
  const { status, reported } = useLiveMeetingStatus(meeting.id, meeting.status);
  const processing = !isTerminal(status);

  return (
    <li>
      <Link
        href={`/meetings/${meeting.id}`}
        className={cn(
          "flex gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/40",
          // Slightly more prominent, still plainly one of the rows around it.
          processing && "border-warning/40 bg-warning/5",
        )}
      >
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{meeting.title}</span>
            {/* One word while it runs. The stage is said in full underneath,
                and a pill that changed from "Transcribing" to "Summarizing"
                would be a second, competing statement of the same thing. */}
            {processing ? (
              <Badge variant="warning">Processing</Badge>
            ) : (
              status !== "READY" && <StatusBadge status={status} />
            )}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {new Date(meeting.createdAt).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })}
            {meeting.durationSeconds ? ` · ${formatDuration(meeting.durationSeconds)}` : ""}
            {meeting.tags.length > 0 ? ` · ${meeting.tags.slice(0, 3).join(", ")}` : ""}
          </span>
          {processing && (
            <ProcessingRow meetingId={meeting.id} status={status} reported={reported} />
          )}
        </span>
      </Link>
    </li>
  );
}
