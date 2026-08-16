"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Sparkles,
  ArrowLeft,
  Trash2,
  Pencil,
  Star,
  MoreHorizontal,
  FileText,
  Calendar,
  Clock,
  FolderMinus,
  Search as SearchIcon,
} from "lucide-react";
import {
  useGetProjectQuery,
  useGetProjectMeetingsQuery,
  useGetProjectChatQuery,
  useGetProjectConversationsQuery,
  useAskProjectChatMutation,
  useCreateProjectConversationMutation,
  useClearProjectChatMutation,
  useUpdateProjectMutation,
  useDeleteProjectMutation,
  useAssignProjectMutation,
  useRenameConversationMutation,
  useDeleteConversationMutation,
  useDeleteChatExchangeMutation,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/status-badge";
import { ScopedChat } from "@/components/scoped-chat";
import { FolderDialog } from "@/components/folder-dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { PROJECT_PROMPTS } from "@/lib/chat-prompts";
import { formatDateTime, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MeetingResponse } from "@/lib/types";

/**
 * One folder: what is in it, and a chat that can only see what is in it.
 *
 * <p>The list comes first and is the shape of the page, because that is what
 * anybody arriving here came for — which conversations are filed under this
 * work. The chat sits below it rather than beside it: it is the reason the
 * grouping exists ("where does the ABC work stand" is a question about a body of
 * work over weeks), but it is not what you open a folder to see.
 */
export default function FolderPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();

  const { data: folder, isLoading } = useGetProjectQuery(id);
  const { data: meetings } = useGetProjectMeetingsQuery(id);

  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const {
    data: messages,
    isLoading: chatLoading,
    isError: chatError,
  } = useGetProjectChatQuery(conversationId ? { id, conversationId } : { id });
  const { data: conversations } = useGetProjectConversationsQuery(id);

  const [ask, { isLoading: asking }] = useAskProjectChatMutation();
  const [newConversation, { isLoading: starting }] = useCreateProjectConversationMutation();
  const [clear, { isLoading: clearing }] = useClearProjectChatMutation();
  const [renameConv] = useRenameConversationMutation();
  const [removeConversation] = useDeleteConversationMutation();
  const [deleteExchange, { isLoading: deleting }] = useDeleteChatExchangeMutation();
  const [remove, { isLoading: removing }] = useDeleteProjectMutation();
  const [update] = useUpdateProjectMutation();
  const [renaming, setRenaming] = React.useState(false);

  const scope = `PRJ-${id}`;

  // Same two recoveries as the workspace chat: follow the thread the server
  // filed the turn under, and drop a thread id that no longer resolves.
  React.useEffect(() => {
    if (!conversationId && messages && messages.length > 0) {
      setConversationId(messages[0].conversationId);
    }
  }, [messages, conversationId]);

  React.useEffect(() => {
    if (chatError && conversationId) setConversationId(null);
  }, [chatError, conversationId]);

  async function send(question: string) {
    try {
      const answer = await ask({ id, question, conversationId: conversationId ?? undefined }).unwrap();
      setConversationId(answer.conversationId);
    } catch {
      toast.error("Couldn't get an answer.");
    }
  }

  async function onDeleteFolder() {
    if (
      !window.confirm(
        `Delete “${folder?.name}”? Its meetings are kept — they move back to Unfiled.`,
      )
    ) {
      return;
    }
    try {
      const { unfiledMeetings } = await remove(id).unwrap();
      toast.success(
        unfiledMeetings > 0
          ? `Folder deleted. ${unfiledMeetings} meeting${unfiledMeetings === 1 ? "" : "s"} moved to Unfiled.`
          : "Folder deleted.",
      );
      router.push("/projects");
    } catch {
      toast.error("Couldn't delete that folder.");
    }
  }

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
          <Link href="/projects" className="underline">
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
        href="/projects"
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

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Folder actions"
                className="rounded p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <MoreHorizontal className="h-5 w-5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onSelect={() => setRenaming(true)}>
                <Pencil className="mr-2 h-4 w-4" /> Rename Folder
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                {/* The folder as a search filter — the same grouping, applied to
                    decisions, commitments and transcripts rather than meetings. */}
                <Link href={`/search?project=${folder.id}`}>
                  <SearchIcon className="mr-2 h-4 w-4" /> Search in folder
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={removing}
                onSelect={(e) => {
                  e.preventDefault();
                  void onDeleteFolder();
                }}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" /> Delete Folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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

      <section className="space-y-4 border-t pt-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="h-4 w-4 text-primary" /> Ask Recallix about this folder
            </h2>
            <p className="text-xs text-muted-foreground">
              Answers are grounded in these {folder.meetingCount} meeting
              {folder.meetingCount === 1 ? "" : "s"} and nothing else.
            </p>
          </div>
          {(conversations?.length ?? 0) > 0 && (
            <Button
              variant="ghost"
              size="sm"
              disabled={clearing}
              onClick={async () => {
                if (!window.confirm("Delete every conversation about this folder?")) return;
                try {
                  await clear(id).unwrap();
                  setConversationId(null);
                } catch {
                  toast.error("Couldn't clear the conversation.");
                }
              }}
              className="shrink-0 gap-1.5 text-xs text-muted-foreground"
            >
              <Trash2 className="h-3.5 w-3.5" /> Clear all
            </Button>
          )}
        </div>

        <ScopedChat
          messages={messages}
          conversations={conversations ?? []}
          conversationId={conversationId}
          onSelectConversation={setConversationId}
          loading={chatLoading}
          asking={asking}
          deleting={deleting}
          starting={starting}
          prompts={PROJECT_PROMPTS}
          emptyLine={`Ask a question about “${folder.name}”.`}
          thinkingLine="Reading this folder's meetings…"
          placeholder={`Ask about ${folder.name}…`}
          onSend={send}
          onNewConversation={async () => {
            try {
              const created = await newConversation(id).unwrap();
              setConversationId(created.id);
            } catch {
              toast.error("Couldn't start a new chat.");
            }
          }}
          onRename={async (cid, title) => {
            await renameConv({ conversationId: cid, title, scope }).unwrap();
          }}
          onDeleteConversation={async (cid) => {
            await removeConversation({ conversationId: cid, scope }).unwrap();
            if (cid === conversationId) setConversationId(null);
          }}
          onDeleteExchange={async (messageId) => {
            const result = await deleteExchange({ messageId, scope }).unwrap();
            if (result.conversationDeleted) setConversationId(null);
          }}
        />
      </section>

      <FolderDialog open={renaming} onOpenChange={setRenaming} folder={folder} />
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
