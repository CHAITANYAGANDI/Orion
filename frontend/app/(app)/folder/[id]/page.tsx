"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeft,
  Star,
  MoreHorizontal,
  FileText,
  Calendar,
  Clock,
  FolderMinus,
} from "lucide-react";
import {
  useGetProjectQuery,
  useGetProjectMeetingsQuery,
  useUpdateProjectMutation,
  useAssignProjectMutation,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/status-badge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { formatDateTime, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { FOLDERS } from "@/lib/routes";
import type { MeetingResponse } from "@/lib/types";

/**
 * One folder: what is filed in it.
 *
 * <p>The list is the whole page now. It is what anybody arriving here came for —
 * which conversations belong to this work — and it used to sit above a chat
 * scoped to the folder, headed "Ask Reverie about this folder".
 *
 * <p><strong>That chat was removed on request, and only from here.</strong> The
 * workspace chat at /ask is untouched, and so is the server: POST
 * /projects/:id/chat, its conversations, and the whole PRJ- scope still exist
 * and still work. Nothing calls them, so a folder's existing chat history is
 * now unreachable rather than deleted — which is the recoverable half of that
 * trade, and worth knowing before anybody wires something new to those routes.
 *
 * <p>Rename, delete and search-in-folder moved to the top bar, beside Record.
 * See components/folder-header-actions.tsx: they are what you do to the folder
 * you are standing in, and having them here meant one set of actions lived in
 * two places.
 */
export default function FolderPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const { data: folder, isLoading } = useGetProjectQuery(id);
  const { data: meetings } = useGetProjectMeetingsQuery(id);

  const [update] = useUpdateProjectMutation();

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!folder) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          That folder no longer exists.{" "}
          <Link href={FOLDERS} className="underline">
            Back to folders
          </Link>
        </CardContent>
      </Card>
    );
  }

  const rows = meetings ?? [];

  return (
    <div className="space-y-6">
      <Link
        href={FOLDERS}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Folders
      </Link>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold tracking-tight">{folder.name}</h1>
          {folder.description && (
            <p className="text-sm text-muted-foreground">{folder.description}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {/* The star is the whole of "this is the folder I am in this week":
              starred folders sort to the top of the rail and the folder list. */}
          <button
            type="button"
            aria-label={folder.favorite ? "Remove star" : "Star this folder"}
            aria-pressed={folder.favorite}
            onClick={() => void update({ id, body: { favorite: !folder.favorite } })}
            className="rounded p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Star
              className={cn("h-5 w-5", folder.favorite && "fill-amber-400 text-amber-400")}
            />
          </button>

        </div>
      </div>

      {/* Named, so it is a landmark a screen reader can jump to and so the
          column header below is not confusable with the chat's own. */}
      <section aria-label={`Conversations in ${folder.name}`}>
        <div className="border-b px-1 pb-2 text-xs font-semibold text-muted-foreground">
          Conversation
        </div>

        {rows.length === 0 ? (
          <p className="px-1 py-10 text-center text-sm text-muted-foreground">
            Nothing filed here yet. Open a meeting and choose this folder, or pick
            it when you upload.
          </p>
        ) : (
          <ul>
            {rows.map((meeting) => (
              <ConversationRow key={meeting.id} meeting={meeting} folderName={folder.name} />
            ))}
          </ul>
        )}
      </section>

    </div>
  );
}

/**
 * One meeting in the folder.
 *
 * <p>The notes icon is only shown once there are notes. A row that carries the
 * same mark whether or not the meeting has been processed says nothing, and this
 * list is exactly where somebody looks to find out which of last week's calls
 * are ready to read.
 */
function ConversationRow({
  meeting,
  folderName,
}: {
  meeting: MeetingResponse;
  folderName: string;
}) {
  const [assign, { isLoading }] = useAssignProjectMutation();
  const ready = meeting.status === "READY";

  return (
    <li className="group flex items-center gap-3 border-b px-1 py-3 transition-colors hover:bg-accent/40">
      <Link href={`/meetings/${meeting.id}`} className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-semibold">{meeting.title}</span>
          {ready && (
            <FileText
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-label="Notes ready"
            />
          )}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            {formatDateTime(meeting.createdAt)}
          </span>
          {meeting.durationSeconds != null && meeting.durationSeconds > 0 && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatDuration(meeting.durationSeconds)}
            </span>
          )}
          {!ready && <StatusBadge status={meeting.status} />}
        </span>
      </Link>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Actions for ${meeting.title}`}
            className="shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem asChild>
            <Link href={`/meetings/${meeting.id}`}>
              <FileText className="mr-2 h-4 w-4" /> Open conversation
            </Link>
          </DropdownMenuItem>
          {/* Removing it from the folder, not deleting it. Deleting a recording
              lives on the meeting page, behind the erase menu, where what is
              about to go can be named one grain at a time. */}
          <DropdownMenuItem
            disabled={isLoading}
            onSelect={async () => {
              try {
                await assign({ meetingId: meeting.id, projectId: null }).unwrap();
                toast.success(`Removed from ${folderName}. The meeting is kept.`);
              } catch {
                toast.error("Couldn't remove that from the folder.");
              }
            }}
          >
            <FolderMinus className="mr-2 h-4 w-4" /> Remove from folder
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
